import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ResearchStack } from '../lib/research-stack';

test('research stack isolates an IAM Gateway, pinned official-domain connector and scoped caller policy', () => {
  const app = new App();
  const stack = new ResearchStack(app, 'Research', { env: { account: '111111111111', region: 'us-east-1' } });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
  template.resourceCountIs('Custom::AWS', 1);
  template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
  template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { AuthorizerType: 'AWS_IAM', ProtocolType: 'MCP' });
  const json = template.toJSON();
  const custom = Object.values(template.findResources('Custom::AWS'))[0].Properties;
  const create = JSON.parse(custom.Create['Fn::Join'][1].filter((item: unknown) => typeof item === 'string').join(''));
  assert.equal(create.action, 'createGatewayTarget');
  assert.equal(create.parameters.targetConfiguration.mcp.connector.source.version, '1.1.0');
  assert.deepEqual(create.parameters.targetConfiguration.mcp.connector.configurations[0].parameterValues.domainFilter.include,
    ['docs.aws.amazon.com', 'aws.amazon.com']);
  const policies = template.findResources('AWS::IAM::ManagedPolicy');
  const caller = Object.values(policies)[0].Properties;
  assert.equal(caller.Roles, undefined);
  assert.ok(!JSON.stringify(json).includes('"Resource":"*"'));
  assert.ok(JSON.stringify(json).includes('tool/web-answer.v1'));
  assert.ok(JSON.stringify(json).includes('aws:SourceAccount'));
  assert.ok(JSON.stringify(json).includes('aws:SourceArn'));
  assert.ok(!JSON.stringify(json).includes('InvokeModelWithResponseStream'));
  const servicePolicy = Object.values(template.findResources('AWS::IAM::Policy'))
    .find((resource: any) => JSON.stringify(resource).includes('InvokeWebAnswer'))!.Properties;
  const role = Object.values(template.findResources('AWS::IAM::Role'))
    .find((resource: any) => JSON.stringify(resource).includes('bedrock-agentcore.amazonaws.com'))!;
  assert.ok(!JSON.stringify(role).includes('GatewayArn'), 'trust must not depend on the Gateway it creates');
  assert.ok(!JSON.stringify(servicePolicy).includes('bedrock:InvokeModel'));
});

test('Web Answer cannot be synthesized in an unsupported region', () => {
  assert.throws(() => new ResearchStack(new App(), 'Research', {
    env: { account: '111111111111', region: 'ap-southeast-1' },
  }), /us-east-1/);
});
