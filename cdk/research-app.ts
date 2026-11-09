import { App } from 'aws-cdk-lib';
import { ResearchStack } from './lib/research-stack';

const app = new App();
new ResearchStack(app, 'CloudProjectMarkerResearch', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
