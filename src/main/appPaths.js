import { join } from 'path'

/**
 * Where the app writes its files. In development they stay in the project folder, as before. The
 * installed app is started from the root of the disk (its working directory is "/", where nothing
 * can be written), so it uses the folders the system gives each app instead.
 */
export function resolveAppPaths({ isPackaged, cwd, documentsDir, logsDir, env = {} }) {
  return {
    meetings:
      env.MEETINGS_DIR ||
      (isPackaged ? join(documentsDir, 'DataWatch', 'meetings') : join(cwd, 'meetings')),
    logs: isPackaged ? logsDir : join(cwd, 'logs')
  }
}
