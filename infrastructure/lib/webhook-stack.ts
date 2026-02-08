import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';

export class WebhookStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubAppId = process.env.GITHUB_APP_ID;
    if (!githubAppId) {
      cdk.Annotations.of(this).addWarning(
        'GITHUB_APP_ID is not set. GitHub App authentication will fail at runtime. Set GITHUB_APP_ID before deploy.'
      );
    }
    const githubInstallationId = process.env.GITHUB_APP_INSTALLATION_ID;

    // ===========================
    // Secrets Manager
    // ===========================
    const githubWebhookSecret = new secretsmanager.Secret(this, 'GitHubWebhookSecret', {
      secretName: 'pullmint/github-webhook-secret',
      description: 'GitHub webhook secret for signature verification',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const anthropicApiKey = new secretsmanager.Secret(this, 'AnthropicApiKey', {
      secretName: 'pullmint/anthropic-api-key',
      description: 'Anthropic API key for LLM agents',
    });

    const githubAppPrivateKey = new secretsmanager.Secret(this, 'GitHubAppPrivateKey', {
      secretName: 'pullmint/github-app-private-key',
      description: 'GitHub App private key for authentication',
    });

    // ===========================
    // DynamoDB Tables
    // ===========================

    // Webhook deduplication table
    const dedupTable = new dynamodb.Table(this, 'WebhookDeduplication', {
      tableName: 'pullmint-webhook-dedup',
      partitionKey: { name: 'deliveryId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // PR executions table
    const executionsTable = new dynamodb.Table(this, 'PRExecutions', {
      tableName: 'pullmint-pr-executions',
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // GSI for querying by repo and timestamp
    executionsTable.addGlobalSecondaryIndex({
      indexName: 'ByRepo',
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
    });

    // LLM cache table
    const cacheTable = new dynamodb.Table(this, 'LLMCache', {
      tableName: 'pullmint-llm-cache',
      partitionKey: { name: 'cacheKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ===========================
    // EventBridge
    // ===========================
    this.eventBus = new events.EventBus(this, 'PullmintEventBus', {
      eventBusName: 'pullmint-events',
    });

    // ===========================
    // SQS Queues
    // ===========================

    // Dead Letter Queue for webhook processing
    const webhookDLQ = new sqs.Queue(this, 'WebhookDLQ', {
      queueName: 'pullmint-webhook-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    // Queue for LLM agent processing
    const llmQueue = new sqs.Queue(this, 'LLMQueue', {
      queueName: 'pullmint-llm-queue',
      visibilityTimeout: cdk.Duration.minutes(5),
      deadLetterQueue: {
        queue: webhookDLQ,
        maxReceiveCount: 3,
      },
    });

    // ===========================
    // Lambda Functions
    // ===========================

    // Webhook receiver
    const webhookHandler = new NodejsFunction(this, 'WebhookReceiver', {
      functionName: 'pullmint-webhook-receiver',
      entry: path.join(__dirname, '../../services/webhook-receiver/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        WEBHOOK_SECRET_ARN: githubWebhookSecret.secretArn,
        DEDUP_TABLE_NAME: dedupTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Architecture Agent
    const architectureAgent = new NodejsFunction(this, 'ArchitectureAgent', {
      functionName: 'pullmint-architecture-agent',
      entry: path.join(__dirname, '../../services/llm-agents/architecture-agent/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        ANTHROPIC_API_KEY_ARN: anthropicApiKey.secretArn,
        GITHUB_APP_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
        GITHUB_APP_ID: githubAppId ?? '',
        ...(githubInstallationId ? { GITHUB_APP_INSTALLATION_ID: githubInstallationId } : {}),
        CACHE_TABLE_NAME: cacheTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // GitHub integration handler
    const githubIntegration = new NodejsFunction(this, 'GitHubIntegration', {
      functionName: 'pullmint-github-integration',
      entry: path.join(__dirname, '../../services/github-integration/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        GITHUB_APP_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
        GITHUB_APP_ID: githubAppId ?? '',
        ...(githubInstallationId ? { GITHUB_APP_INSTALLATION_ID: githubInstallationId } : {}),
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // ===========================
    // Permissions
    // ===========================

    // Webhook handler permissions
    this.eventBus.grantPutEventsTo(webhookHandler);
    githubWebhookSecret.grantRead(webhookHandler);
    dedupTable.grantReadWriteData(webhookHandler);
    executionsTable.grantReadWriteData(webhookHandler);

    // Architecture agent permissions
    anthropicApiKey.grantRead(architectureAgent);
    githubAppPrivateKey.grantRead(architectureAgent);
    cacheTable.grantReadWriteData(architectureAgent);
    executionsTable.grantReadWriteData(architectureAgent);
    this.eventBus.grantPutEventsTo(architectureAgent);

    // GitHub integration permissions
    githubAppPrivateKey.grantRead(githubIntegration);
    executionsTable.grantReadWriteData(githubIntegration);

    // ===========================
    // EventBridge Rules
    // ===========================

    // Route PR events to LLM queue
    new events.Rule(this, 'RoutePRToLLM', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.github'],
        detailType: ['pr.opened', 'pr.synchronize', 'pr.reopened'],
      },
      targets: [new targets.SqsQueue(llmQueue)],
    });

    // Route analysis completion to GitHub integration
    new events.Rule(this, 'RouteAnalysisComplete', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.agent'],
        detailType: ['analysis.complete'],
      },
      targets: [new targets.LambdaFunction(githubIntegration)],
    });

    // ===========================
    // SQS Event Sources
    // ===========================

    // Connect LLM queue to architecture agent
    architectureAgent.addEventSource(
      new SqsEventSource(llmQueue, {
        batchSize: 1,
        maxConcurrency: 5,
      })
    );

    // ===========================
    // API Gateway
    // ===========================

    const api = new apigateway.RestApi(this, 'WebhookAPI', {
      restApiName: 'Pullmint Webhook API',
      description: 'Receives GitHub webhook events',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod('POST', new apigateway.LambdaIntegration(webhookHandler), {
      methodResponses: [{ statusCode: '202' }, { statusCode: '401' }, { statusCode: '500' }],
    });

    // ===========================
    // Outputs
    // ===========================

    this.webhookUrl = api.url + 'webhook';

    new cdk.CfnOutput(this, 'WebhookURL', {
      value: this.webhookUrl,
      description: 'Webhook URL for GitHub',
      exportName: 'PullmintWebhookURL',
    });

    new cdk.CfnOutput(this, 'WebhookSecretArn', {
      value: githubWebhookSecret.secretArn,
      description: 'ARN of webhook secret in Secrets Manager',
      exportName: 'PullmintWebhookSecretArn',
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'EventBridge bus name',
      exportName: 'PullmintEventBusName',
    });

    new cdk.CfnOutput(this, 'ExecutionsTableName', {
      value: executionsTable.tableName,
      description: 'DynamoDB table for PR executions',
      exportName: 'PullmintExecutionsTableName',
    });
  }
}
