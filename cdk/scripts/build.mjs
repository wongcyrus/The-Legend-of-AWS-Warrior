import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'cdk/.build');
const exam = process.argv.includes('--exam');
const voice = process.argv.includes('--voice');
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });

// All generated files stay outside the SAM workspace and tracked frontend sources.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const dotnet = process.env.DOTNET_ROOT
  ? join(process.env.DOTNET_ROOT, 'dotnet')
  : 'dotnet';
run(dotnet, [
  'publish', 'src/ServerlessAPI/ServerlessAPI.csproj',
  '-c', 'Release', '-r', 'linux-x64', '--self-contained', 'false',
  '-o', join(output, 'backend'),
]);

const webSource = join(output, 'web-source');
cpSync(join(root, 'web-app'), webSource, {
  recursive: true,
  filter: source => !['node_modules', 'build'].includes(basename(source)) &&
    !basename(source).startsWith('.env'),
});
writeFileSync(join(webSource, 'src/Constant.js'),
  "export const baseUrl = new URL('/Prod/', window.location.origin).href;\n");
run('npm', ['ci', '--no-audit', '--no-fund'], webSource);
run('npm', ['run', 'build'], webSource, {
  ...process.env, REACT_APP_EXAM_MODE: String(exam), GENERATE_SOURCEMAP: 'false',
});
const website = join(output, 'website');
cpSync(join(webSource, 'build'), website, { recursive: true });
rmSync(webSource, { recursive: true, force: true });
if (!exam) {
  cpSync(join(root, 'web-game'), website, {
    recursive: true,
    filter: source => !['node_modules', 'tests', '.git'].includes(basename(source)),
  });
  writeFileSync(join(website, 'src/constant.js'),
    "export const baseUrl = new URL('/Prod/', window.location.origin).href;\n");
}
if (voice) {
  for (const [source, target] of [['VoiceAgent', 'voice-agent'], ['VoicePractice', 'voice']]) {
    const destination = join(output, target);
    cpSync(join(root, 'src', source), destination, {
      recursive: true,
      filter: file => !['node_modules', '.git'].includes(basename(file)) &&
        !file.endsWith('.test.mjs'),
    });
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      ...(source === 'VoiceAgent' ? ['--cpu=arm64', '--os=linux'] : [])], destination);
  }
}
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ exam, voice }));
if (!existsSync(join(output, 'backend/ServerlessAPI.dll'))) {
  throw new Error('The Lambda publish output is missing ServerlessAPI.dll');
}
