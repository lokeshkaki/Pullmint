import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
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

    const gsiStage = this.node.tryGetContext('gsiStage') as string | undefined;
    const normalizedGsiStage = gsiStage?.trim();
    const allowedGsiStages = new Set(['ByRepo', 'ByRepoPr', 'ByTimestamp', 'all']);
    const gsiStageOrder = ['ByRepo', 'ByRepoPr', 'ByTimestamp'];

    if (normalizedGsiStage && !allowedGsiStages.has(normalizedGsiStage)) {
      cdk.Annotations.of(this).addWarning(
        `Unknown gsiStage "${normalizedGsiStage}". Expected one of: ByRepo, ByRepoPr, ByTimestamp, all.`
      );
    }

    if (!normalizedGsiStage) {
      cdk.Annotations.of(this).addWarning(
        'DynamoDB only allows one GSI create/delete per update. For existing tables, deploy with -c gsiStage=ByRepo|ByRepoPr|ByTimestamp and repeat per index in order.'
      );
    }

    const shouldAddGsi = (indexName: string): boolean => {
      if (!normalizedGsiStage || normalizedGsiStage === 'all') {
        return true;
      }

      const maxIndex = gsiStageOrder.indexOf(normalizedGsiStage);
      const currentIndex = gsiStageOrder.indexOf(indexName);
      if (maxIndex === -1 || currentIndex === -1) {
        return true;
      }

      return currentIndex <= maxIndex;
    };

    // GSI for querying by repo and timestamp
    if (shouldAddGsi('ByRepo')) {
      executionsTable.addGlobalSecondaryIndex({
        indexName: 'ByRepo',
        partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      });
    }

    if (shouldAddGsi('ByRepoPr')) {
      executionsTable.addGlobalSecondaryIndex({
        indexName: 'ByRepoPr',
        partitionKey: { name: 'repoPrKey', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      });
    }

    if (shouldAddGsi('ByTimestamp')) {
      executionsTable.addGlobalSecondaryIndex({
        indexName: 'ByTimestamp',
        partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      });
    }

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

    const deploymentDLQ = new sqs.Queue(this, 'DeploymentDLQ', {
      queueName: 'pullmint-deployment-dlq',
      retentionPeriod: cdk.Duration.days(14),
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
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        DEPLOYMENT_CONFIG: JSON.stringify({
          deploymentStrategy: process.env.DEPLOYMENT_STRATEGY || 'eventbridge',
          deploymentRiskThreshold: Number(process.env.DEPLOYMENT_RISK_THRESHOLD || '30'),
          autoApproveRiskThreshold: Number(process.env.AUTO_APPROVE_RISK_THRESHOLD || '30'),
          deploymentLabel: process.env.DEPLOYMENT_LABEL || 'deploy:staging',
          deploymentEnvironment: process.env.DEPLOYMENT_ENVIRONMENT || 'staging',
          deploymentRequireTests: (process.env.DEPLOYMENT_REQUIRE_TESTS || 'false') === 'true',
          deploymentRequiredContexts: (process.env.DEPLOYMENT_REQUIRED_CONTEXTS || '')
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        }),
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Deployment orchestrator
    const deploymentOrchestrator = new NodejsFunction(this, 'DeploymentOrchestrator', {
      functionName: 'pullmint-deployment-orchestrator',
      entry: path.join(__dirname, '../../services/deployment-orchestrator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        DEPLOYMENT_WEBHOOK_URL: process.env.DEPLOYMENT_WEBHOOK_URL || '',
        DEPLOYMENT_WEBHOOK_AUTH_TOKEN: process.env.DEPLOYMENT_WEBHOOK_AUTH_TOKEN || '',
        DEPLOYMENT_WEBHOOK_TIMEOUT_MS: process.env.DEPLOYMENT_WEBHOOK_TIMEOUT_MS || '10000',
        DEPLOYMENT_WEBHOOK_RETRIES: process.env.DEPLOYMENT_WEBHOOK_RETRIES || '2',
        DEPLOYMENT_ROLLBACK_WEBHOOK_URL: process.env.DEPLOYMENT_ROLLBACK_WEBHOOK_URL || '',
        DEPLOYMENT_DELAY_MS: process.env.DEPLOYMENT_DELAY_MS || '0',
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Dashboard API
    const dashboardApi = new NodejsFunction(this, 'DashboardApi', {
      functionName: 'pullmint-dashboard-api',
      entry: path.join(__dirname, '../../services/dashboard-api/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Dashboard UI
    const dashboardUi = new NodejsFunction(this, 'DashboardUi', {
      functionName: 'pullmint-dashboard-ui',
      entry: path.join(__dirname, '../../services/dashboard-ui/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
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
    this.eventBus.grantPutEventsTo(githubIntegration);

    // Deployment orchestrator permissions
    executionsTable.grantReadWriteData(deploymentOrchestrator);
    this.eventBus.grantPutEventsTo(deploymentOrchestrator);

    // Dashboard permissions
    executionsTable.grantReadData(dashboardApi);

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

    // Route deployment approvals to orchestrator
    new events.Rule(this, 'RouteDeploymentApproved', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.review'],
        detailType: ['deployment_approved'],
      },
      targets: [
        new targets.LambdaFunction(deploymentOrchestrator, {
          deadLetterQueue: deploymentDLQ,
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(2),
        }),
      ],
    });

    // Route deployment status updates to GitHub integration
    new events.Rule(this, 'RouteDeploymentStatus', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.orchestrator', 'pullmint.github'],
        detailType: ['deployment.status'],
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
    // Dashboard routes
    // ===========================

    const dashboardResource = api.root.addResource('dashboard');

    // Dashboard UI route (GET /dashboard)
    dashboardResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardUi), {
      methodResponses: [{ statusCode: '200' }],
    });

    // Dashboard API routes
    const executionsResource = dashboardResource.addResource('executions');
    executionsResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    const executionResource = executionsResource.addResource('{executionId}');
    executionResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // Dashboard repo routes (GET /dashboard/repos/:owner/:repo/prs/:number)
    const reposResource = dashboardResource.addResource('repos');
    const ownerResource = reposResource.addResource('{owner}');
    const repoResource = ownerResource.addResource('{repo}');
    const prsResource = repoResource.addResource('prs');
    const prNumberResource = prsResource.addResource('{number}');
    prNumberResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // Enable CORS for dashboard endpoints
    const dashboardCors = {
      allowOrigins: ['*'],
      allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    };

    dashboardResource.addCorsPreflight(dashboardCors);
    executionsResource.addCorsPreflight(dashboardCors);
    executionResource.addCorsPreflight(dashboardCors);
    prNumberResource.addCorsPreflight(dashboardCors);

    // ===========================
    // CloudWatch Alarms
    // ===========================

    // Deployment orchestrator error alarm
    new cloudwatch.Alarm(this, 'DeploymentOrchestratorErrors', {
      alarmName: 'pullmint-deployment-orchestrator-errors',
      alarmDescription: 'Alert when deployment orchestrator has elevated error rate',
      metric: deploymentOrchestrator.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // GitHub integration error alarm
    new cloudwatch.Alarm(this, 'GitHubIntegrationErrors', {
      alarmName: 'pullmint-github-integration-errors',
      alarmDescription: 'Alert when GitHub integration has elevated error rate',
      metric: githubIntegration.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Webhook handler error alarm
    new cloudwatch.Alarm(this, 'WebhookHandlerErrors', {
      alarmName: 'pullmint-webhook-handler-errors',
      alarmDescription: 'Alert when webhook handler has elevated error rate',
      metric: webhookHandler.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
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

    new cdk.CfnOutput(this, 'DashboardURL', {
      value: api.url + 'dashboard',
      description: 'Dashboard UI URL',
      exportName: 'PullmintDashboardURL',
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
