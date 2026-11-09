import { App } from 'aws-cdk-lib';
import { WarriorStack } from './lib/warrior-stack';

const app = new App();
const mode = app.node.tryGetContext('mode') ?? 'prod';
if (mode !== 'prod' && mode !== 'exam') {
  throw new Error('mode must be prod or exam');
}
const voice = app.node.tryGetContext('voice') ?? 'false';
if (voice !== 'true' && voice !== 'false') {
  throw new Error('voice must be true or false');
}
const stackName = app.node.tryGetContext('stackName') ??
  (mode === 'exam' ? 'CloudProjectMarkerCdkExam' : 'CloudProjectMarkerCdk');

new WarriorStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  examMode: mode === 'exam',
  voiceEnabled: voice === 'true',
});
