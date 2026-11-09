import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { yamlParse } from 'yaml-cfn';
import { WarriorStack } from '../lib/warrior-stack';

function verifyReferences(template: Template) {
  const json = template.toJSON();
  const edges = new Map<string, Set<string>>();
  for (const [id, resource] of Object.entries(json.Resources)) {
    const dependencies = new Set<string>();
    const reference = (name: string) => {
      if (name.startsWith('AWS::') || json.Parameters?.[name]) return;
      assert.ok(json.Resources[name], `${id} references missing resource ${name}`);
      dependencies.add(name);
    };
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (value === null || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (typeof node.Ref === 'string') reference(node.Ref);
      if (Array.isArray(node['Fn::GetAtt'])) reference(String(node['Fn::GetAtt'][0]));
      if (node['Fn::Sub']) {
        const [text, bindings] = typeof node['Fn::Sub'] === 'string'
          ? [node['Fn::Sub'], {}]
          : node['Fn::Sub'] as [string, Record<string, unknown>];
        for (const match of text.matchAll(/\$\{([^!}][^}]*)\}/g)) {
          if (!(match[1] in bindings)) reference(match[1].split('.')[0]);
        }
      }
      Object.values(node).forEach(visit);
    };
    visit(resource);
    const explicit = (resource as { DependsOn?: string | string[] }).DependsOn ?? [];
    for (const dependency of typeof explicit === 'string' ? [explicit] : explicit) reference(dependency);
    edges.set(id, dependencies);
  }
  const complete = new Set<string>();
  const check = (id: string, path: Set<string>) => {
    assert.ok(!path.has(id), `Circular dependency: ${[...path, id].join(' -> ')}`);
    if (complete.has(id)) return;
    for (const next of edges.get(id) ?? []) check(next, new Set([...path, id]));
    complete.add(id);
  };
  for (const id of edges.keys()) check(id, new Set());
}

function synth(exam: boolean, voice: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'warrior-cdk-'));
  try {
    for (const asset of ['backend', 'website', 'voice', 'voice-agent']) {
      mkdirSync(join(directory, asset));
      writeFileSync(join(directory, asset, 'fixture.txt'), 'test asset');
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ exam, voice }));
    const app = new App({ outdir: join(directory, 'out') });
    const stack = new WarriorStack(app, 'TestWarrior', {
      env: { account: '111111111111', region: 'us-east-1' },
      examMode: exam, voiceEnabled: voice, assetRoot: directory,
    });
    const template = Template.fromStack(stack);
    app.synth();
    verifyReferences(template);
    return template;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('deploys native backend and website together without SAM or endpoint parameters', () => {
  const template = synth(false, false);
  const json = template.toJSON();
  assert.equal(json.Transform, undefined);
  assert.equal(json.Parameters.SecretHash.NoEcho, true);
  assert.equal(json.Parameters.SecretHash.Default, undefined);
  assert.equal(json.Parameters.WebApiEndpoint, undefined);
  template.resourceCountIs('AWS::ApiGateway::Account', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 5);
  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    DestinationBucketName: { Ref: 'WebAppS3Bucket' },
    DistributionId: { Ref: 'CloudFrontDistribution' },
    DistributionPaths: ['/*'],
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      CacheBehaviors: [{
        PathPattern: 'Prod/*',
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
        ViewerProtocolPolicy: 'https-only',
        TargetOriginId: json.Resources.CloudFrontDistribution.Properties.DistributionConfig.CacheBehaviors[0].TargetOriginId,
      }],
    },
  });
  assert.ok(!JSON.stringify(json.Outputs).includes('SecretHash'));
});

test('retains the SAM route contracts, API-key requirements and function environment', () => {
  const template = synth(true, false);
  const sam = yamlParse(readFileSync(join(__dirname, '../../template.yaml'), 'utf8'));
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as {
    Properties: { HttpMethod: string; ApiKeyRequired?: boolean; RestApiId: unknown;
      ResourceId: { Ref?: string }; Integration: unknown };
  }[];
  const json = template.toJSON();
  const routePath = (resourceId: { Ref?: string }): string => {
    if (!resourceId.Ref) return '';
    const resource = json.Resources[resourceId.Ref].Properties;
    return `${routePath(resource.ParentId)}/${resource.PathPart}`;
  };
  for (const [id, resource] of Object.entries(sam.Resources) as [string, {
    Type: string; Condition?: string; Properties: {
      Handler: string; Environment: unknown; Events?: Record<string, {
        Properties: { Path: string; Method: string; RestApiId: { Ref: string }; Auth?: { ApiKeyRequired: boolean } };
      }>;
    };
  }][]) {
    if (resource.Type !== 'AWS::Serverless::Function' || resource.Condition) continue;
    const fn = template.toJSON().Resources[id];
    assert.equal(fn.Properties.Handler, resource.Properties.Handler);
    assert.deepEqual(fn.Properties.Environment, resource.Properties.Environment);
    for (const event of Object.values(resource.Properties.Events ?? {})) {
      if (event.Properties.Method.toUpperCase() === 'OPTIONS') continue;
      const expectedKey = event.Properties.Auth?.ApiKeyRequired ??
        event.Properties.RestApiId.Ref === 'ApiGatewayApi';
      assert.ok(methods.some(method =>
        method.Properties.HttpMethod === event.Properties.Method.toUpperCase() &&
        routePath(method.Properties.ResourceId) === event.Properties.Path &&
        JSON.stringify(method.Properties.RestApiId) === JSON.stringify(event.Properties.RestApiId) &&
        method.Properties.ApiKeyRequired === expectedKey &&
        JSON.stringify(method.Properties.Integration).includes(id)));
    }
  }
  for (const table of Object.values(template.findResources('AWS::DynamoDB::Table')) as {
    DeletionPolicy: string; UpdateReplacePolicy: string;
  }[]) {
    assert.equal(table.DeletionPolicy, 'Retain');
    assert.equal(table.UpdateReplacePolicy, 'Retain');
  }
});

test('voice deployment uses CDK assets and preserves encryption, async failures and public pairing routes', () => {
  const template = synth(false, true);
  const json = template.toJSON();
  assert.equal(json.Parameters.VoiceAgentCodeBucket, undefined);
  assert.equal(json.Parameters.VoiceAgentCodeKey, undefined);
  template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    FunctionName: { Ref: 'VoicePracticeFunction' },
    MaximumRetryAttempts: 1,
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': ['VoiceFailureQueue', 'Arn'] } } },
  });
  assert.deepEqual(json.Resources.VoicePracticeFunction.DependsOn, ['VoiceAgentLogGroup']);
  template.resourceCountIs('AWS::KMS::Key', 0);
  for (const name of ['VoicePracticeLogGroup', 'VoiceLogConfiguratorLogGroup', 'VoiceAgentLogGroup']) {
    assert.equal(json.Resources[name].Properties.KmsKeyId, undefined);
  }
  assert.ok(!JSON.stringify(json).includes('kms:'));
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as {
    Properties: { HttpMethod: string; ApiKeyRequired: boolean; Integration?: { Uri?: unknown } };
  }[];
  assert.equal(methods.filter(method => method.Properties.ApiKeyRequired === false &&
    method.Properties.HttpMethod !== 'OPTIONS' &&
    JSON.stringify(method.Properties.Integration).includes('VoicePracticeFunction')).length, 2);
  assert.ok(!JSON.stringify(json).includes('voice-agent-not-configured'));
});

test('scheduler scans the deployed table and preserves pagination through grading', () => {
  const template = synth(true, false);
  const workflow = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as {
    Properties: { DefinitionString: {
      'Fn::Join': [string, (string | { Ref: string } | { 'Fn::GetAtt': string[] })[]];
    } };
  };
  const [separator, parts] = workflow.Properties.DefinitionString['Fn::Join'];
  const definition = JSON.parse(parts.map(part => typeof part === 'string'
    ? part : 'Ref' in part ? part.Ref : part['Fn::GetAtt'].join('.')).join(separator));
  assert.equal(definition.States.Scan.Parameters.TableName, 'AwsAccountTable');
  assert.equal(definition.States.Scan.Parameters['ExclusiveStartKey.$'], undefined);
  assert.equal(definition.States.ScanNext.Parameters['ExclusiveStartKey.$'], '$.LastEvaluatedKey');
  assert.equal(definition.States.Grade.ResultPath, null);
  assert.equal(definition.States.More.Choices[0].Next, 'ScanNext');
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    State: { 'Fn::If': ['ScheduleEnabled', 'ENABLED', 'DISABLED'] },
  });
});

test('rejects assets built for a different deployment mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'warrior-cdk-mode-'));
  try {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ exam: false, voice: true }));
    assert.throws(() => new WarriorStack(new App(), 'WrongMode', {
      assetRoot: directory, examMode: true, voiceEnabled: false,
    }), /Asset build does not match/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
