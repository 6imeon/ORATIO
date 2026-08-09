import { SherpaSession } from './sherpa'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * ASR worker entry point — runs inside a `utilityProcess`, never in main and
 * never in a worker thread.
 *
 * Electron warns that native modules in worker threads cause "crashes and
 * memory corruptions" (`process.dlopen` is not thread safe), and sherpa is a
 * native addon. A `utilityProcess` is a real OS process with its own crash
 * domain, which buys two things that matter more than the spawn cost:
 * a model that fails to load kills only this process, and `kill()` reclaims
 * every byte the inference allocated. See ARCHITECTURE §1.3.
 *
 * The process handles exactly one job and is then killed by the host.
 */

const session = new SherpaSession()

function send(msg: WorkerResponse): void {
  // parentPort is always present under utilityProcess; the guard is for the
  // case where this file is loaded directly by a test harness.
  process.parentPort?.postMessage(msg)
}

function handle(req: WorkerRequest): void {
  try {
    switch (req.type) {
      case 'load':
        session.load(req.modelId, req.files, req.vadModelPath, req.vadEnabled, req.onnxUsable)
        send({ type: 'ok', id: req.id })
        break

      case 'transcribe': {
        const segments = session.transcribe(req.wavPath, (progress) => {
          send({ type: 'progress', id: req.id, progress })
        })
        send({ type: 'ok', id: req.id, segments })
        break
      }

      case 'release':
        session.release()
        send({ type: 'ok', id: req.id })
        break
    }
  } catch (err) {
    // Every failure comes back as a reply rather than an unhandled throw. An
    // uncaught error here would exit the process, and the host would see only
    // a mute `exit` — which is how "failed to load model" becomes a hang
    // instead of a message the user can act on (ARCHITECTURE §4.4).
    send({
      type: 'err',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

// Attached before anything else can run, and before `ready` is sent. If the
// host's first request arrived while no listener was registered, `exit` would
// beat `message` and the reply would be lost with no error anywhere.
process.parentPort?.on('message', (e) => handle(e.data as WorkerRequest))

// Sherpa is synchronous, so an uncaught async error should not be possible —
// but if one happens, exiting silently would strand the host on a promise that
// never settles. Better to die visibly.
process.on('uncaughtException', (err) => {
  send({ type: 'err', id: -1, message: `worker crashed: ${err.message}` })
  process.exit(1)
})

send({ type: 'ready' })
