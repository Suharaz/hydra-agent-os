// Render the director's single film. Never boot HYDRA or mutate trading state.
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = resolve(root, 'video/remotion');
if (!existsSync(resolve(cwd, 'public/director-audio-en.wav'))) throw new Error('Missing director-audio-en.wav. Run: NARRATION=narration-en.json python video/audio/generate-audio.py');
mkdirSync(resolve(cwd, 'out'), {recursive:true});
const processResult = Bun.spawnSync(['bunx','remotion','render','src/index.ts','HydraDirectorFilm','out/hydra-director-final.mp4','--concurrency=4','--crf=18'], {cwd, stdout:'inherit', stderr:'inherit'});
if (processResult.exitCode !== 0) process.exit(processResult.exitCode || 1);
console.log('Completed: video/remotion/out/hydra-director-final.mp4');
