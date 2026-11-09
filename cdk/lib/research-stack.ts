import { CfnOutput, Stack, StackProps, aws_bedrockagentcore as agentcore, aws_iam as iam, custom_resources as cr } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class ResearchStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);
    if (this.region !== 'us-east-1') throw new Error('Web Answer research requires us-east-1');

    const gatewayResources = this.formatArn({ service: 'bedrock-agentcore', resource: 'gateway', resourceName: '*' });
    const role = new iam.Role(this, 'GatewayServiceRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': gatewayResources },
        },
      }),
    });
    const gateway = new agentcore.CfnGateway(this, 'ResearchGateway', {
      name: 'aws-warrior-question-research',
      authorizerType: 'AWS_IAM',
      protocolType: 'MCP',
      roleArn: role.roleArn,
      description: 'Official AWS evidence for offline draft interview questions; not student grading.',
    });
    const servicePolicy = new iam.Policy(this, 'GatewayServicePolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeGateway'], resources: [gateway.attrGatewayArn],
        }),
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeWebAnswer'],
          resources: [this.formatArn({
            service: 'bedrock-agentcore', account: 'aws', resource: 'tool', resourceName: 'web-answer.v1',
          })],
        }),
      ],
    });
    servicePolicy.attachToRole(role);
    const parameters = {
      name: 'official-aws',
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: 'web-answer', version: '1.1.0' },
            configurations: [{
              name: 'WebAnswer',
              parameterValues: { domainFilter: { include: ['docs.aws.amazon.com', 'aws.amazon.com'] } },
            }],
          },
        },
      },
    };
    // CloudFormation ConnectorSource lacks Version; the control API supports pinning.
    const target = new cr.AwsCustomResource(this, 'OfficialAwsWebAnswer', {
      onCreate: {
        service: '@aws-sdk/client-bedrock-agentcore-control', action: 'createGatewayTarget', parameters,
        physicalResourceId: cr.PhysicalResourceId.fromResponse('targetId'),
        outputPaths: ['targetId'],
      },
      onUpdate: {
        service: '@aws-sdk/client-bedrock-agentcore-control', action: 'updateGatewayTarget',
        parameters: { ...parameters, targetIdentifier: new cr.PhysicalResourceIdReference() },
        outputPaths: ['targetId'],
      },
      onDelete: {
        service: '@aws-sdk/client-bedrock-agentcore-control', action: 'deleteGatewayTarget',
        parameters: { gatewayIdentifier: gateway.attrGatewayIdentifier, targetIdentifier: new cr.PhysicalResourceIdReference() },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateGatewayTarget', 'bedrock-agentcore:UpdateGatewayTarget', 'bedrock-agentcore:DeleteGatewayTarget',
        ],
        resources: [gateway.attrGatewayArn],
      })]),
      installLatestAwsSdk: true,
    });
    target.node.addDependency(servicePolicy);

    const callerPolicy = new iam.ManagedPolicy(this, 'GeneratorCallerPolicy', {
      description: 'Attach explicitly to the local generator identity. No student-runtime access.',
      statements: [
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeGateway'], resources: [gateway.attrGatewayArn],
        }),
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [
            ...['zai.glm-5', 'deepseek.v3.2', 'qwen.qwen3-next-80b-a3b', 'moonshotai.kimi-k2.5'].map(model =>
              this.formatArn({ service: 'bedrock', account: '', resource: 'foundation-model', resourceName: model })),
            this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: 'us.amazon.nova-2-lite-v1:0' }),
            // Nova's US inference profile may route to any supported US destination.
            this.formatArn({ service: 'bedrock', region: 'us-*', account: '', resource: 'foundation-model', resourceName: 'amazon.nova-2-lite-v1:0' }),
          ],
        }),
      ],
    });
    new CfnOutput(this, 'WebAnswerUrl', { value: gateway.attrGatewayUrl });
    new CfnOutput(this, 'GatewayArn', { value: gateway.attrGatewayArn });
    new CfnOutput(this, 'GeneratorCallerPolicyArn', { value: callerPolicy.managedPolicyArn });
  }
}
