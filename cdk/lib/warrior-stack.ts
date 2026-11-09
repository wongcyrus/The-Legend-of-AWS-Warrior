import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CfnCondition, CfnDeletionPolicy, CfnOutput, CfnParameter, CfnResource, Duration, Fn,
  RemovalPolicy, Stack, StackProps,
  aws_apigateway as apigateway, aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins, aws_dynamodb as dynamodb,
  aws_iam as iam, aws_lambda as lambda, aws_s3 as s3,
  aws_s3_assets as assets, aws_s3_deployment as deployment,
  aws_scheduler as scheduler, aws_stepfunctions as sfn,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { yamlParse } from 'yaml-cfn';

interface Resource {
  Type: string;
  Properties: Record<string, unknown>;
  Condition?: string;
  DependsOn?: string | string[];
  DeletionPolicy?: CfnDeletionPolicy;
  UpdateReplacePolicy?: CfnDeletionPolicy;
  Metadata?: Record<string, unknown>;
}

interface FunctionDefinition {
  Handler: string;
  Timeout?: number;
  Environment?: { Variables: Record<string, string | { Ref: string }> };
  Policies?: {
    Statement?: Record<string, unknown>[];
    DynamoDBCrudPolicy?: { TableName: { Ref: string } };
    S3CrudPolicy?: { BucketName: { Ref: string } };
  }[];
  Events?: Record<string, {
    Properties: {
      Path: string;
      Method: string;
      RestApiId: { Ref: string };
      Auth?: { ApiKeyRequired: boolean };
    };
  }>;
}

export interface WarriorStackProps extends StackProps {
  readonly examMode?: boolean;
  readonly voiceEnabled?: boolean;
  readonly assetRoot?: string;
}

const root = resolve(__dirname, '../..');

function logicalId(construct: Construct, id: string): void {
  (construct.node.defaultChild as CfnResource).overrideLogicalId(id);
}

function intrinsicTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(intrinsicTokens);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.Ref === 'string') return Fn.ref(record.Ref);
  if (Array.isArray(record['Fn::GetAtt'])) {
    const [resource, attribute] = record['Fn::GetAtt'] as string[];
    return Fn.getAtt(resource, attribute).toString();
  }
  if (typeof record['Fn::Sub'] === 'string') return Fn.sub(record['Fn::Sub']);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, intrinsicTokens(item)]));
}

// Keep shared data schemas, handler contracts and voice security configuration in
// template.yaml; only native CloudFormation resources are emitted by this app.
export class WarriorStack extends Stack {
  constructor(scope: Construct, id: string, props: WarriorStackProps = {}) {
    super(scope, id, props);
    const assetRoot = props.assetRoot ?? join(root, 'cdk/.build');
    const manifest = JSON.parse(readFileSync(join(assetRoot, 'manifest.json'), 'utf8')) as {
      exam: boolean; voice: boolean;
    };
    if (manifest.exam !== Boolean(props.examMode) || manifest.voice !== Boolean(props.voiceEnabled)) {
      throw new Error('Asset build does not match mode/voice context. Re-run npm run build with --exam/--voice as appropriate.');
    }
    const template = yamlParse(readFileSync(join(root, 'template.yaml'), 'utf8')) as {
      Resources: Record<string, Resource>;
    };
    new CfnParameter(this, 'SecretHash', {
      type: 'String', noEcho: true, minLength: 1,
      description: 'Stable encryption secret for student API keys. Required on initial deployment.',
    });
    const tables: Record<string, dynamodb.ITable> = {};
    for (const [name, definition] of Object.entries(template.Resources)) {
      if (definition.Type !== 'AWS::DynamoDB::Table' || definition.Condition) continue;
      const table = new CfnResource(this, name, { type: definition.Type, properties: definition.Properties });
      table.overrideLogicalId(name);
      table.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
      table.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
      tables[name] = dynamodb.Table.fromTableAttributes(this, `${name}Reference`, {
        tableName: table.ref,
        globalIndexes: name === 'AwsAccountTable' ? ['AwsAccountNumberIndex'] : undefined,
      });
    }
    const reports = new s3.Bucket(this, 'TestResultBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    logicalId(reports, 'TestResultBucket');
    const website = new s3.Bucket(this, 'WebAppS3Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    logicalId(website, 'WebAppS3Bucket');
    const api = new apigateway.RestApi(this, 'ApiGatewayApi', {
      restApiName: `${this.stackName}-api`,
      cloudWatchRole: false,
      deployOptions: { stageName: 'Prod', tracingEnabled: true },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowHeaders: [...apigateway.Cors.DEFAULT_HEADERS, 'x-api-key'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        maxAge: Duration.minutes(10),
      },
    });
    logicalId(api, 'ApiGatewayApi');
    const keyApi = new apigateway.RestApi(this, 'KeyGenApiGatewayApi', {
      restApiName: `${this.stackName}-key-api`,
      cloudWatchRole: false,
      deployOptions: { stageName: 'Prod' },
    });
    logicalId(keyApi, 'KeyGenApiGatewayApi');
    for (const [name, type] of Object.entries({
      Default4xx: apigateway.ResponseType.DEFAULT_4XX,
      Default5xx: apigateway.ResponseType.DEFAULT_5XX,
      Unauthorized: apigateway.ResponseType.UNAUTHORIZED,
      MissingAuth: apigateway.ResponseType.MISSING_AUTHENTICATION_TOKEN,
      AccessDenied: apigateway.ResponseType.ACCESS_DENIED,
      InvalidKey: apigateway.ResponseType.INVALID_API_KEY,
    })) {
      api.addGatewayResponse(name, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': "'*'",
          'Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,x-api-key'",
          'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
        },
      });
    }
    const usage = api.addUsagePlan('APIUsagePlan', {
      name: `${this.stackName}-grader-usage-plan`,
      quota: { limit: 2880, period: apigateway.Period.DAY },
      throttle: { burstLimit: 60, rateLimit: 60 },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    logicalId(usage, 'APIUsagePlan');
    const functions: Record<string, lambda.Function> = {};
    const code = lambda.Code.fromAsset(join(assetRoot, 'backend'));
    for (const [name, definition] of Object.entries(template.Resources)) {
      if (definition.Type !== 'AWS::Serverless::Function' || definition.Condition) continue;
      const config = definition.Properties as unknown as FunctionDefinition;
      const environment = Object.fromEntries(Object.entries(config.Environment?.Variables ?? {})
        .map(([key, value]) => [key, typeof value === 'string' ? value : Fn.ref(value.Ref)]));
      const fn = new lambda.Function(this, name, {
        code, handler: config.Handler, runtime: lambda.Runtime.DOTNET_8,
        architecture: lambda.Architecture.X86_64, memorySize: 1024,
        timeout: Duration.seconds(config.Timeout ?? 900),
        tracing: lambda.Tracing.ACTIVE, environment,
      });
      logicalId(fn, name);
      functions[name] = fn;
      for (const policy of config.Policies ?? []) {
        if (policy.DynamoDBCrudPolicy) {
          tables[policy.DynamoDBCrudPolicy.TableName.Ref].grantReadWriteData(fn);
        } else if (policy.S3CrudPolicy) {
          reports.grantReadWrite(fn);
        } else {
          for (const statement of policy.Statement ?? []) {
            fn.addToRolePolicy(iam.PolicyStatement.fromJson(intrinsicTokens(statement)));
          }
        }
      }
      for (const event of Object.values(config.Events ?? {})) {
        const route = event.Properties;
        if (route.Method.toUpperCase() === 'OPTIONS') continue;
        const target = route.RestApiId.Ref === 'KeyGenApiGatewayApi' ? keyApi : api;
        target.root.resourceForPath(route.Path).addMethod(route.Method.toUpperCase(),
          new apigateway.LambdaIntegration(fn), {
            apiKeyRequired: route.Auth?.ApiKeyRequired ?? target === api,
          });
      }
    }
    const distribution = new cloudfront.Distribution(this, 'CloudFrontDistribution', {
      defaultRootObject: 'index.html',
      errorResponses: [400, 403, 404, 405, 500, 502, 503, 504]
        .map(httpStatus => ({ httpStatus, ttl: Duration.seconds(0) })),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(website),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: new cloudfront.Function(this, 'SpaRoutes', {
            code: cloudfront.FunctionCode.fromInline(
              "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) r.uri = '/index.html'; return r; }"),
          }),
        }],
      },
      additionalBehaviors: {
        'Prod/*': {
          origin: new origins.HttpOrigin(`${api.restApiId}.execute-api.${this.region}.${this.urlSuffix}`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });
    logicalId(distribution, 'CloudFrontDistribution');
    if (props.voiceEnabled) {
      this.addVoice(template.Resources, assetRoot, api);
    }
    for (const name of ['ApplicationResourceGroup', 'ApplicationInsightsMonitoring']) {
      const definition = template.Resources[name];
      const resource = new CfnResource(this, name, {
        type: definition.Type,
        properties: name === 'ApplicationInsightsMonitoring'
          ? { ...definition.Properties, AutoConfigurationEnabled: true }
          : definition.Properties,
      });
      resource.overrideLogicalId(name);
    }
    this.addScheduler(functions.StepFunctionGraderFunction, tables.AwsAccountTable);
    const upload = new deployment.BucketDeployment(this, 'WebsiteAssets', {
      sources: [deployment.Source.asset(join(assetRoot, 'website'))],
      destinationBucket: website,
      distribution, distributionPaths: ['/*'],
      memoryLimit: 1024,
    });
    upload.node.addDependency(api.deploymentStage);
    const outputs = {
      WebApiEndpoint: `https://${api.restApiId}.execute-api.${this.region}.${this.urlSuffix}/`,
      // Do not publish SecretHash in CloudFormation outputs.
      KeygenApiEndpoint: `${keyApi.url}keygen`,
      KeyTestApiEndpoint: `${api.url}keytest?email=`,
      UsagePlanId: usage.usagePlanId,
      UsagePlanName: `${this.stackName}-grader-usage-plan`,
      TestResultBucket: reports.bucketName,
      PassedTestTable: tables.PassedTestTable.tableName,
      FailedTestTable: tables.FailedTestTable.tableName,
      ApiKeyLookupTable: tables.ApiKeyLookupTable.tableName,
      WebAppDomain: distribution.distributionDomainName,
      CloudFrontDistributionId: distribution.distributionId,
      WebAppS3BucketName: website.bucketName,
      WebsiteUrl: `https://${distribution.distributionDomainName}`,
    };
    for (const [name, value] of Object.entries(outputs)) {
      new CfnOutput(this, `${name}Output`, { value }).overrideLogicalId(name);
    }
  }

  private addVoice(resources: Record<string, Resource>, assetRoot: string, api: apigateway.RestApi): void {
    const agent = new assets.Asset(this, 'VoiceAgentCode', { path: join(assetRoot, 'voice-agent') });
    const backend = new assets.Asset(this, 'VoiceBackendCode', { path: join(assetRoot, 'voice') });
    new CfnParameter(this, 'VoiceModelId', {
      type: 'String', default: 'us.amazon.nova-2-lite-v1:0',
      allowedPattern: '(?:(?:us|eu|ap|global)[.])?amazon[.][a-zA-Z0-9.:-]+',
    });
    const replacements: Record<string, string> = {
      VoiceAgentCodeBucket: agent.s3BucketName,
      VoiceAgentCodeKey: agent.s3ObjectKey,
    };
    const replace = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(replace);
      if (value === null || typeof value !== 'object') return value;
      const record = value as Record<string, unknown>;
      if (typeof record.Ref === 'string' && replacements[record.Ref]) return replacements[record.Ref];
      if (typeof record['Fn::Sub'] === 'string') {
        const text = record['Fn::Sub'];
        const bindings = Object.fromEntries(Object.entries(replacements)
          .filter(([name]) => text.includes(`\${${name}}`)));
        return { 'Fn::Sub': Object.keys(bindings).length ? [text, bindings] : text };
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, replace(item)]));
    };
    for (const [name, definition] of Object.entries(resources)) {
      if (definition.Condition !== 'VoicePracticeEnabled' || name === 'VoicePracticeFunction') continue;
      const resource = new CfnResource(this, name, {
        type: definition.Type,
        properties: replace(definition.Properties) as Record<string, unknown>,
      });
      resource.overrideLogicalId(name);
      resource.cfnOptions.deletionPolicy = definition.DeletionPolicy;
      resource.cfnOptions.updateReplacePolicy = definition.UpdateReplacePolicy;
      resource.cfnOptions.metadata = definition.Metadata;
      if (definition.DependsOn) resource.addOverride('DependsOn', definition.DependsOn);
    }
    const config = resources.VoicePracticeFunction.Properties;
    const policies = config.Policies as { Statement: Record<string, unknown>[] }[];
    const role = new CfnResource(this, 'VoicePracticeRole', {
      type: 'AWS::IAM::Role',
      properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17', Statement: [{
            Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole',
          }],
        },
        ManagedPolicyArns: [
          Fn.sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'),
          Fn.sub('arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess'),
        ],
        Policies: [{
          PolicyName: 'VoicePractice',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              ...policies.flatMap(policy => policy.Statement),
              { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: { 'Fn::GetAtt': ['VoiceFailureQueue', 'Arn'] } },
            ],
          },
        }],
      },
    });
    role.overrideLogicalId('VoicePracticeRole');
    const fn = new CfnResource(this, 'VoicePracticeFunction', {
      type: 'AWS::Lambda::Function',
      properties: {
        Runtime: 'nodejs22.x', Handler: config.Handler,
        Code: { S3Bucket: backend.s3BucketName, S3Key: backend.s3ObjectKey },
        Role: role.getAtt('Arn'), Timeout: config.Timeout, MemorySize: config.MemorySize,
        ReservedConcurrentExecutions: config.ReservedConcurrentExecutions,
        Environment: config.Environment, TracingConfig: { Mode: 'Active' },
      },
    });
    fn.overrideLogicalId('VoicePracticeFunction');
    fn.addOverride('DependsOn', ['VoiceAgentLogGroup']);
    new lambda.CfnEventInvokeConfig(this, 'VoiceAsyncConfig', {
      functionName: fn.ref, qualifier: '$LATEST',
      maximumEventAgeInSeconds: 300, maximumRetryAttempts: 1,
      destinationConfig: { onFailure: { destination: Fn.getAtt('VoiceFailureQueue', 'Arn').toString() } },
    });
    const imported = lambda.Function.fromFunctionAttributes(this, 'VoiceApiHandler', {
      functionArn: fn.getAtt('Arn').toString(), sameEnvironment: true,
    });
    const events = config.Events as FunctionDefinition['Events'];
    for (const event of Object.values(events ?? {})) {
      const route = event.Properties;
      api.root.resourceForPath(route.Path).addMethod(route.Method.toUpperCase(),
        new apigateway.LambdaIntegration(imported), {
          apiKeyRequired: route.Auth?.ApiKeyRequired ?? true,
        });
    }
    for (const [name, value] of Object.entries({
      VoicePracticeTableName: Fn.ref('VoicePracticeTable'),
      VoicePracticeRuntimeArn: Fn.getAtt('VoiceAgentRuntime', 'AgentRuntimeArn').toString(),
      VoicePracticeAudioBucketName: Fn.ref('VoiceAudioBucket'),
      VoicePracticeFunctionName: fn.ref,
    })) new CfnOutput(this, name, { value });
  }

  private addScheduler(grader: lambda.Function, table: dynamodb.ITable): void {
    const enabled = new CfnParameter(this, 'ScheduleGrader', {
      type: 'String', default: 'disable', allowedValues: ['enable', 'disable'],
    });
    const expression = new CfnParameter(this, 'ScheduleExpression', {
      type: 'String', default: 'cron(0 * * * ? *)',
      allowedValues: ['cron(0/5 * * * ? *)', 'cron(0 * * * ? *)', 'cron(0 0 * * ? *)'],
    });
    const condition = new CfnCondition(this, 'ScheduleEnabled', {
      expression: Fn.conditionEquals(enabled.valueAsString, 'enable'),
    });
    // Scan results must survive the Map, and only subsequent scans have a cursor.
    const scan = (next: boolean) => ({
      Type: 'Task', Resource: `arn:${this.partition}:states:::aws-sdk:dynamodb:scan`,
      Parameters: {
        TableName: table.tableName, ProjectionExpression: '#User',
        ExpressionAttributeNames: { '#User': 'User' },
        ...(next ? { 'ExclusiveStartKey.$': '$.LastEvaluatedKey' } : {}),
      },
      Next: 'Grade',
    });
    const workflow = new sfn.StateMachine(this, 'GradeAllStudentsStateMachine', {
      definitionBody: sfn.DefinitionBody.fromString(JSON.stringify({
        StartAt: 'Scan', States: {
          Scan: scan(false), ScanNext: scan(true),
          Grade: {
            Type: 'Map', ItemsPath: '$.Items', MaxConcurrency: 100, ResultPath: null,
            ItemSelector: { 'Email.$': '$$.Map.Item.Value.User.S' },
            ItemProcessor: {
              ProcessorConfig: { Mode: 'INLINE' }, StartAt: 'Invoke',
              States: { Invoke: {
                Type: 'Task', Resource: `arn:${this.partition}:states:::lambda:invoke`,
                Parameters: { FunctionName: grader.functionArn, 'Payload.$': '$' }, End: true,
              } },
            },
            Next: 'More',
          },
          More: {
            Type: 'Choice', Choices: [{
              Variable: '$.LastEvaluatedKey', IsPresent: true, Next: 'ScanNext',
            }], Default: 'Done',
          },
          Done: { Type: 'Succeed' },
        },
      })),
    });
    table.grantReadData(workflow);
    grader.grantInvoke(workflow);
    const role = new iam.Role(this, 'ScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': Fn.sub('arn:${AWS::Partition}:scheduler:${AWS::Region}:${AWS::AccountId}:schedule-group/default') },
        },
      }),
    });
    workflow.grantStartExecution(role);
    new scheduler.CfnSchedule(this, 'GradingSchedule', {
      scheduleExpression: expression.valueAsString,
      state: Fn.conditionIf(condition.logicalId, 'ENABLED', 'DISABLED').toString(),
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: workflow.stateMachineArn, roleArn: role.roleArn, input: '{}' },
    });
    this.templateOptions.description = 'AWS Warrior: native CDK resources and assets, no SAM deployment phases.';
  }
}
