import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    const deploymentWebhookSecret = new secretsmanager.Secret(this, 'DeploymentWebhookSecret', {
      secretName: 'pullmint/deployment-webhook',
      description: 'Deployment webhook URL and auth token',
    });

    const signalIngestionSecret = new secretsmanager.Secret(this, 'SignalIngestionSecret', {
      secretName: 'pullmint/signal-ingestion-hmac-secret',
      description: 'HMAC secret for Pullmint signal ingestion webhook',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const dashboardAuthSecret = new secretsmanager.Secret(this, 'DashboardAuthSecret', {
      secretName: 'pullmint/dashboard-auth-token',
      description: 'Bearer token for dashboard API authentication',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
        'No gsiStage specified. Deploying with all GSIs. For tables with existing GSIs, use -c gsiStage=all. For new table initial deployment with incremental GSI creation, deploy 3 times with gsiStage=ByRepo, then ByRepoPr, then ByTimestamp.'
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

    if (shouldAddGsi('StatusDeployedAtIndex')) {
      executionsTable.addGlobalSecondaryIndex({
        indexName: 'StatusDeployedAtIndex',
        partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'deploymentStartedAt', type: dynamodb.AttributeType.NUMBER },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    // LLM rate limit table — atomic per-repo hourly counters to cap API spend
    const llmRateLimitTable = new dynamodb.Table(this, 'LLMRateLimitTable', {
      tableName: 'pullmint-llm-rate-limit',
      partitionKey: { name: 'counterKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // LLM cache table
    const cacheTable = new dynamodb.Table(this, 'LLMCache', {
      tableName: 'pullmint-llm-cache',
      partitionKey: { name: 'cacheKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Knowledge base tables
    const fileKnowledgeTable = new dynamodb.Table(this, 'FileKnowledgeTable', {
      tableName: 'pullmint-file-knowledge',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const authorProfilesTable = new dynamodb.Table(this, 'AuthorProfilesTable', {
      tableName: 'pullmint-author-profiles',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const repoRegistryTable = new dynamodb.Table(this, 'RepoRegistryTable', {
      tableName: 'pullmint-repo-registry',
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const moduleNarrativesTable = new dynamodb.Table(this, 'ModuleNarrativesTable', {
      tableName: 'pullmint-module-narratives',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    moduleNarrativesTable.addGlobalSecondaryIndex({
      indexName: 'repoFullName-index',
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ===========================
    // S3
    // ===========================

    // Analysis results bucket — stores full LLM outputs for audit trail and to avoid
    // EventBridge's 256KB event size limit when findings arrays are large
    const analysisResultsBucket = new s3.Bucket(this, 'AnalysisResultsBucket', {
      bucketName: `pullmint-analysis-results-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
          id: 'expire-after-90-days',
        },
      ],
    });

    const dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      bucketName: `pullmint-dashboard-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../services/dashboard-ui/static'))],
      destinationBucket: dashboardBucket,
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.hours(1)),
      ],
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
      visibilityTimeout: cdk.Duration.minutes(12),
      deadLetterQueue: {
        queue: webhookDLQ,
        maxReceiveCount: 3,
      },
    });

    const deploymentDLQ = new sqs.Queue(this, 'DeploymentDLQ', {
      queueName: 'pullmint-deployment-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const onboardingDlq = new sqs.Queue(this, 'OnboardingDlq', {
      queueName: 'pullmint-onboarding-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const onboardingQueue = new sqs.Queue(this, 'OnboardingQueue', {
      queueName: 'pullmint-onboarding-queue',
      visibilityTimeout: cdk.Duration.minutes(90),
      deadLetterQueue: { queue: onboardingDlq, maxReceiveCount: 3 },
    });

    const knowledgeUpdateDlq = new sqs.Queue(this, 'KnowledgeUpdateDlq', {
      queueName: 'pullmint-knowledge-update-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const knowledgeUpdateQueue = new sqs.Queue(this, 'KnowledgeUpdateQueue', {
      queueName: 'pullmint-knowledge-update-queue',
      visibilityTimeout: cdk.Duration.minutes(90),
      deadLetterQueue: { queue: knowledgeUpdateDlq, maxReceiveCount: 3 },
    });

    const oneMonthLambdaLogGroup = (id: string): logs.LogGroup =>
      new logs.LogGroup(this, id, {
        retention: logs.RetentionDays.ONE_MONTH,
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
      logGroup: oneMonthLambdaLogGroup('WebhookReceiverLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
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
      logGroup: oneMonthLambdaLogGroup('ArchitectureAgentLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ANTHROPIC_API_KEY_ARN: anthropicApiKey.secretArn,
        GITHUB_APP_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
        GITHUB_APP_ID: githubAppId ?? '',
        ...(githubInstallationId ? { GITHUB_APP_INSTALLATION_ID: githubInstallationId } : {}),
        CACHE_TABLE_NAME: cacheTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        ANALYSIS_RESULTS_BUCKET: analysisResultsBucket.bucketName,
        LLM_RATE_LIMIT_TABLE: llmRateLimitTable.tableName,
        LLM_HOURLY_LIMIT_PER_REPO: '10',
        LLM_SMALL_DIFF_MODEL: 'claude-haiku-4-5-20251001',
        LLM_LARGE_DIFF_MODEL: 'claude-sonnet-4-6',
        LLM_SMALL_DIFF_LINE_THRESHOLD: '500',
        LLM_MAX_TOKENS: '2000',
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
      logGroup: oneMonthLambdaLogGroup('GitHubIntegrationLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        GITHUB_APP_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
        GITHUB_APP_ID: githubAppId ?? '',
        ...(githubInstallationId ? { GITHUB_APP_INSTALLATION_ID: githubInstallationId } : {}),
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        ANALYSIS_RESULTS_BUCKET: analysisResultsBucket.bucketName,
        DASHBOARD_URL: process.env.DASHBOARD_URL || '',
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
      logGroup: oneMonthLambdaLogGroup('DeploymentOrchestratorLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        DEPLOYMENT_WEBHOOK_SECRET_ARN: deploymentWebhookSecret.secretArn,
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
      logGroup: oneMonthLambdaLogGroup('DashboardApiLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        DEDUP_TABLE_NAME: dedupTable.tableName,
        DASHBOARD_AUTH_SECRET_ARN: dashboardAuthSecret.secretArn,
        DASHBOARD_ALLOWED_ORIGINS: process.env.DASHBOARD_ALLOWED_ORIGINS ?? '',
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
      logGroup: oneMonthLambdaLogGroup('DashboardUiLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Signal Ingestion Lambda
    const signalIngestionFn = new NodejsFunction(this, 'SignalIngestionFunction', {
      functionName: 'pullmint-signal-ingestion',
      entry: path.join(__dirname, '../../services/signal-ingestion/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: oneMonthLambdaLogGroup('SignalIngestionLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        SIGNAL_INGESTION_SECRET_ARN: signalIngestionSecret.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // ===========================
    // Phase 4: Calibration + Dependency Graph Tables
    // ===========================

    // Calibration table — permanent, no TTL
    const calibrationTable = new dynamodb.Table(this, 'CalibrationTable', {
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Org dependency graph table — 48h TTL, refreshed nightly
    const dependencyGraphTable = new dynamodb.Table(this, 'DependencyGraphTable', {
      partitionKey: { name: 'repoFullName', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dependentRepo', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    });

    // Deployment Monitor Lambda
    const deploymentMonitorFn = new NodejsFunction(this, 'DeploymentMonitorFunction', {
      functionName: 'pullmint-deployment-monitor',
      entry: path.join(__dirname, '../../services/deployment-monitor/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logGroup: oneMonthLambdaLogGroup('DeploymentMonitorLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        ROLLBACK_RISK_THRESHOLD: '50',
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Calibration Service Lambda
    const calibrationServiceFn = new NodejsFunction(this, 'CalibrationServiceFunction', {
      functionName: 'pullmint-calibration-service',
      entry: path.join(__dirname, '../../services/calibration-service/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: oneMonthLambdaLogGroup('CalibrationServiceLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        CALIBRATION_TABLE_NAME: calibrationTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Dependency Scanner Lambda
    const dependencyScannerFn = new NodejsFunction(this, 'DependencyScannerFunction', {
      functionName: 'pullmint-dependency-scanner',
      entry: path.join(__dirname, '../../services/dependency-scanner/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: oneMonthLambdaLogGroup('DependencyScannerLogGroup'),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        REPO_REGISTRY_TABLE_NAME: repoRegistryTable.tableName,
        DEPENDENCY_GRAPH_TABLE_NAME: dependencyGraphTable.tableName,
        GITHUB_APP_ID: githubAppId ?? '',
        GITHUB_APP_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Repo Indexer Lambda
    const repoIndexerFn = new NodejsFunction(this, 'RepoIndexerFunction', {
      functionName: 'pullmint-repo-indexer',
      entry: path.join(__dirname, '../../services/repo-indexer/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 1024,
      logGroup: oneMonthLambdaLogGroup('RepoIndexerLogGroup'),
      timeout: cdk.Duration.minutes(15),
      environment: {
        REPO_REGISTRY_TABLE_NAME: repoRegistryTable.tableName,
        FILE_KNOWLEDGE_TABLE_NAME: fileKnowledgeTable.tableName,
        AUTHOR_PROFILES_TABLE_NAME: authorProfilesTable.tableName,
        MODULE_NARRATIVES_TABLE_NAME: moduleNarrativesTable.tableName,
        EXECUTIONS_TABLE_NAME: executionsTable.tableName,
        ANALYSIS_QUEUE_URL: llmQueue.queueUrl,
        ONBOARDING_QUEUE_URL: onboardingQueue.queueUrl,
        ANTHROPIC_API_KEY_ARN: anthropicApiKey.secretArn,
        GITHUB_APP_ID: githubAppId ?? '',
        GITHUB_PRIVATE_KEY_ARN: githubAppPrivateKey.secretArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Repo indexer permissions
    repoRegistryTable.grantReadWriteData(repoIndexerFn);
    fileKnowledgeTable.grantReadWriteData(repoIndexerFn);
    authorProfilesTable.grantReadWriteData(repoIndexerFn);
    moduleNarrativesTable.grantReadWriteData(repoIndexerFn);
    executionsTable.grantReadData(repoIndexerFn);
    llmQueue.grantSendMessages(repoIndexerFn);
    onboardingQueue.grantSendMessages(repoIndexerFn);
    anthropicApiKey.grantRead(repoIndexerFn);
    githubAppPrivateKey.grantRead(repoIndexerFn);

    repoIndexerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
      })
    );

    // SQS triggers for repo indexer
    repoIndexerFn.addEventSource(new SqsEventSource(onboardingQueue, { batchSize: 1 }));
    repoIndexerFn.addEventSource(new SqsEventSource(knowledgeUpdateQueue, { batchSize: 1 }));

    // ===========================
    // Permissions
    // ===========================
    // Webhook handler permissions
    this.eventBus.grantPutEventsTo(webhookHandler);
    githubWebhookSecret.grantRead(webhookHandler);
    dedupTable.grantReadWriteData(webhookHandler);
    executionsTable.grantReadWriteData(webhookHandler);
    webhookHandler.addEnvironment('REPO_REGISTRY_TABLE_NAME', repoRegistryTable.tableName);
    repoRegistryTable.grantReadWriteData(webhookHandler);

    // Architecture agent permissions
    anthropicApiKey.grantRead(architectureAgent);
    githubAppPrivateKey.grantRead(architectureAgent);
    cacheTable.grantReadWriteData(architectureAgent);
    executionsTable.grantReadWriteData(architectureAgent);
    this.eventBus.grantPutEventsTo(architectureAgent);
    analysisResultsBucket.grantPut(architectureAgent);
    llmRateLimitTable.grantReadWriteData(architectureAgent);
    calibrationTable.grantReadData(architectureAgent);
    architectureAgent.addEnvironment('CALIBRATION_TABLE_NAME', calibrationTable.tableName);
    architectureAgent.addEnvironment('REPO_REGISTRY_TABLE_NAME', repoRegistryTable.tableName);
    architectureAgent.addEnvironment('FILE_KNOWLEDGE_TABLE_NAME', fileKnowledgeTable.tableName);
    architectureAgent.addEnvironment('AUTHOR_PROFILES_TABLE_NAME', authorProfilesTable.tableName);
    architectureAgent.addEnvironment(
      'MODULE_NARRATIVES_TABLE_NAME',
      moduleNarrativesTable.tableName
    );
    repoRegistryTable.grantReadData(architectureAgent);
    fileKnowledgeTable.grantReadData(architectureAgent);
    authorProfilesTable.grantReadData(architectureAgent);
    moduleNarrativesTable.grantReadData(architectureAgent);
    architectureAgent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
      })
    );

    // GitHub integration permissions
    githubAppPrivateKey.grantRead(githubIntegration);
    executionsTable.grantReadWriteData(githubIntegration);
    this.eventBus.grantPutEventsTo(githubIntegration);
    analysisResultsBucket.grantRead(githubIntegration);

    // Deployment orchestrator permissions
    executionsTable.grantReadWriteData(deploymentOrchestrator);
    this.eventBus.grantPutEventsTo(deploymentOrchestrator);
    deploymentWebhookSecret.grantRead(deploymentOrchestrator);
    calibrationTable.grantReadData(deploymentOrchestrator);
    deploymentOrchestrator.addEnvironment('CALIBRATION_TABLE_NAME', calibrationTable.tableName);

    // Dashboard permissions
    executionsTable.grantReadData(dashboardApi);
    executionsTable.grantWriteData(dashboardApi); // needed for re-evaluate overrideHistory update
    calibrationTable.grantReadData(dashboardApi);
    dedupTable.grantReadWriteData(dashboardApi);
    dashboardApi.addEnvironment('CALIBRATION_TABLE_NAME', calibrationTable.tableName);
    dashboardApi.addEnvironment('REPO_REGISTRY_TABLE_NAME', repoRegistryTable.tableName);
    repoRegistryTable.grantReadWriteData(dashboardApi);
    this.eventBus.grantPutEventsTo(dashboardApi);
    dashboardApi.addEnvironment('EVENT_BUS_NAME', this.eventBus.eventBusName);
    dashboardAuthSecret.grantRead(dashboardApi);

    // Signal ingestion permissions
    executionsTable.grantReadWriteData(signalIngestionFn);
    this.eventBus.grantPutEventsTo(signalIngestionFn);
    signalIngestionSecret.grantRead(signalIngestionFn);

    // Deployment monitor permissions
    executionsTable.grantReadWriteData(deploymentMonitorFn);
    this.eventBus.grantPutEventsTo(deploymentMonitorFn);

    // Calibration service permissions
    calibrationTable.grantReadWriteData(calibrationServiceFn);
    executionsTable.grantReadData(calibrationServiceFn);

    // Dependency scanner permissions
    repoRegistryTable.grantReadData(dependencyScannerFn);
    dependencyGraphTable.grantReadWriteData(dependencyScannerFn);
    githubAppPrivateKey.grantRead(dependencyScannerFn);

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
      targets: [
        new targets.LambdaFunction(githubIntegration, {
          deadLetterQueue: webhookDLQ,
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(2),
        }),
      ],
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
      targets: [
        new targets.LambdaFunction(githubIntegration, {
          deadLetterQueue: webhookDLQ,
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(2),
        }),
      ],
    });

    // Scheduled trigger: deployment monitor runs every 5 minutes
    new events.Rule(this, 'DeploymentMonitorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(deploymentMonitorFn)],
    });

    // Route deployment.rollback events from monitor to orchestrator
    new events.Rule(this, 'DeploymentRollbackRule', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.monitor'],
        detailType: ['deployment.rollback'],
      },
      targets: [
        new targets.LambdaFunction(deploymentOrchestrator, {
          deadLetterQueue: deploymentDLQ,
          retryAttempts: 2,
          maxEventAge: cdk.Duration.hours(2),
        }),
      ],
    });

    // Route execution.confirmed → calibration service
    new events.Rule(this, 'ExecutionConfirmedRule', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.monitor'],
        detailType: ['execution.confirmed'],
      },
      targets: [new targets.LambdaFunction(calibrationServiceFn)],
    });

    // Route execution.rolled-back → calibration service
    new events.Rule(this, 'ExecutionRolledBackRule', {
      eventBus: this.eventBus,
      eventPattern: {
        source: ['pullmint.orchestrator'],
        detailType: ['execution.rolled-back'],
      },
      targets: [new targets.LambdaFunction(calibrationServiceFn)],
    });

    // repo.onboarding.requested → onboarding queue
    new events.Rule(this, 'OnboardingRule', {
      eventBus: this.eventBus,
      eventPattern: { source: ['pullmint.github'], detailType: ['repo.onboarding.requested'] },
      targets: [new targets.SqsQueue(onboardingQueue)],
    });

    // pr.merged → knowledge-update queue
    new events.Rule(this, 'PRMergedRule', {
      eventBus: this.eventBus,
      eventPattern: { source: ['pullmint.github'], detailType: ['pr.merged'] },
      targets: [new targets.SqsQueue(knowledgeUpdateQueue)],
    });

    // Nightly schedule for dependency scanner: 02:00 UTC
    new events.Rule(this, 'DependencyScannerSchedule', {
      schedule: events.Schedule.cron({ hour: '2', minute: '0' }),
      targets: [new targets.LambdaFunction(dependencyScannerFn)],
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

    // Signal ingestion route: POST /signals/{executionId}
    const signalsResource = api.root.addResource('signals');
    const signalsByIdResource = signalsResource.addResource('{executionId}');
    signalsByIdResource.addMethod('POST', new apigateway.LambdaIntegration(signalIngestionFn), {
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '400' },
        { statusCode: '401' },
        { statusCode: '404' },
      ],
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

    // GET /dashboard/executions/{executionId}/checkpoints
    const checkpointsResource = executionResource.addResource('checkpoints');
    checkpointsResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // POST /dashboard/executions/{executionId}/re-evaluate
    const reEvaluateResource = executionResource.addResource('re-evaluate');
    reEvaluateResource.addMethod('POST', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [
        { statusCode: '202' },
        { statusCode: '404' },
        { statusCode: '429' },
        { statusCode: '500' },
      ],
    });

    // GET /dashboard/board
    const boardResource = dashboardResource.addResource('board');
    boardResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '500' }],
    });

    // GET /dashboard/calibration
    const calibrationResource = dashboardResource.addResource('calibration');
    calibrationResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '500' }],
    });

    // GET /dashboard/calibration/{owner}/{repo}
    const calibrationOwnerResource = calibrationResource.addResource('{owner}');
    const calibrationRepoResource = calibrationOwnerResource.addResource('{repo}');
    calibrationRepoResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // Dashboard repo routes (GET /dashboard/repos/:owner/:repo/prs/:number)
    const reposResource = dashboardResource.addResource('repos');
    const ownerResource = reposResource.addResource('{owner}');
    const repoResource = ownerResource.addResource('{repo}');
    // GET /dashboard/repos/:owner/:repo (repo registry lookup)
    repoResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // POST /dashboard/repos/:owner/:repo/reindex
    const reindexResource = repoResource.addResource('reindex');
    reindexResource.addMethod('POST', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '202' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    const prsResource = repoResource.addResource('prs');
    const prNumberResource = prsResource.addResource('{number}');
    prNumberResource.addMethod('GET', new apigateway.LambdaIntegration(dashboardApi), {
      methodResponses: [{ statusCode: '200' }, { statusCode: '404' }, { statusCode: '500' }],
    });

    // Enable CORS for dashboard endpoints
    const dashboardCors = {
      allowOrigins: process.env.DASHBOARD_ALLOWED_ORIGINS
        ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
        : ['https://YOUR_DOMAIN_HERE'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    };

    dashboardResource.addCorsPreflight(dashboardCors);
    executionsResource.addCorsPreflight(dashboardCors);
    executionResource.addCorsPreflight(dashboardCors);
    checkpointsResource.addCorsPreflight(dashboardCors);
    reEvaluateResource.addCorsPreflight(dashboardCors);
    boardResource.addCorsPreflight(dashboardCors);
    calibrationResource.addCorsPreflight(dashboardCors);
    calibrationRepoResource.addCorsPreflight(dashboardCors);
    repoResource.addCorsPreflight(dashboardCors);
    reindexResource.addCorsPreflight(dashboardCors);
    prNumberResource.addCorsPreflight(dashboardCors);

    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'DashboardSecurityHeaders',
      {
        responseHeadersPolicyName: 'pullmint-dashboard-security',
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy:
              "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            override: true,
          },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          contentTypeOptions: { override: true },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(730),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
        },
      }
    );

    const dashboardDistribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    dashboardDistribution.addBehavior(
      '/dashboard/*',
      new origins.HttpOrigin(
        `${api.restApiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com`,
        { originPath: `/${api.deploymentStage.stageName}` }
      ),
      {
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      }
    );

    dashboardUi.addEnvironment(
      'DASHBOARD_URL',
      `https://${dashboardDistribution.distributionDomainName}`
    );

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

    // Webhook DLQ depth alarm — any message means a PR event was permanently dropped
    new cloudwatch.Alarm(this, 'WebhookDLQDepth', {
      alarmName: 'pullmint-webhook-dlq-depth',
      alarmDescription: 'Messages in webhook DLQ indicate permanently dropped PR events',
      metric: webhookDLQ.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Deployment DLQ depth alarm — any message means a deployment event was permanently dropped
    new cloudwatch.Alarm(this, 'DeploymentDLQDepth', {
      alarmName: 'pullmint-deployment-dlq-depth',
      alarmDescription: 'Messages in deployment DLQ indicate permanently dropped deployment events',
      metric: deploymentDLQ.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ===========================
    // CloudWatch Dashboard
    // ===========================

    const dashboard = new cloudwatch.Dashboard(this, 'PullmintDashboard', {
      dashboardName: 'pullmint-overview',
    });

    // Row 1: Lambda Invocations and Errors
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        width: 12,
        left: [
          webhookHandler.metricInvocations({ statistic: 'Sum', label: 'Webhook Handler' }),
          architectureAgent.metricInvocations({ statistic: 'Sum', label: 'Architecture Agent' }),
          githubIntegration.metricInvocations({ statistic: 'Sum', label: 'GitHub Integration' }),
          deploymentOrchestrator.metricInvocations({
            statistic: 'Sum',
            label: 'Deployment Orchestrator',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        width: 12,
        left: [
          webhookHandler.metricErrors({
            statistic: 'Sum',
            label: 'Webhook Handler',
            color: cloudwatch.Color.RED,
          }),
          architectureAgent.metricErrors({
            statistic: 'Sum',
            label: 'Architecture Agent',
            color: cloudwatch.Color.ORANGE,
          }),
          githubIntegration.metricErrors({
            statistic: 'Sum',
            label: 'GitHub Integration',
            color: cloudwatch.Color.PURPLE,
          }),
          deploymentOrchestrator.metricErrors({
            statistic: 'Sum',
            label: 'Deployment Orchestrator',
            color: cloudwatch.Color.PINK,
          }),
        ],
      })
    );

    // Row 2: Lambda Duration and Throttles
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (ms)',
        width: 12,
        left: [
          webhookHandler.metricDuration({ statistic: 'Average', label: 'Webhook Handler (avg)' }),
          architectureAgent.metricDuration({
            statistic: 'Average',
            label: 'Architecture Agent (avg)',
          }),
          githubIntegration.metricDuration({
            statistic: 'Average',
            label: 'GitHub Integration (avg)',
          }),
          deploymentOrchestrator.metricDuration({
            statistic: 'Average',
            label: 'Deployment Orchestrator (avg)',
          }),
        ],
        right: [
          architectureAgent.metricDuration({
            statistic: 'Maximum',
            label: 'Architecture Agent (max)',
            color: cloudwatch.Color.GREY,
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles & Concurrent Executions',
        width: 12,
        left: [
          webhookHandler.metricThrottles({
            statistic: 'Sum',
            label: 'Webhook Throttles',
            color: cloudwatch.Color.RED,
          }),
          architectureAgent.metricThrottles({
            statistic: 'Sum',
            label: 'Agent Throttles',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        right: [
          architectureAgent.metric('ConcurrentExecutions', {
            statistic: 'Maximum',
            label: 'Agent Concurrent',
            color: cloudwatch.Color.BLUE,
          }),
        ],
      })
    );

    // Row 3: DynamoDB Metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed Capacity',
        width: 12,
        left: [
          executionsTable.metricConsumedReadCapacityUnits({
            statistic: 'Sum',
            label: 'Executions Read',
          }),
          cacheTable.metricConsumedReadCapacityUnits({ statistic: 'Sum', label: 'Cache Read' }),
        ],
        right: [
          executionsTable.metricConsumedWriteCapacityUnits({
            statistic: 'Sum',
            label: 'Executions Write',
            color: cloudwatch.Color.PURPLE,
          }),
          cacheTable.metricConsumedWriteCapacityUnits({
            statistic: 'Sum',
            label: 'Cache Write',
            color: cloudwatch.Color.PINK,
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Throttles & Latency',
        width: 12,
        left: [
          executionsTable.metricSystemErrorsForOperations({
            operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM],
            statistic: 'Sum',
            label: 'System Errors',
            color: cloudwatch.Color.RED,
          }),
          executionsTable.metricUserErrors({
            statistic: 'Sum',
            label: 'User Errors',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
        right: [
          executionsTable.metricSuccessfulRequestLatency({
            dimensionsMap: { Operation: 'GetItem', TableName: executionsTable.tableName },
            statistic: 'Average',
            label: 'GetItem Latency (avg)',
            color: cloudwatch.Color.BLUE,
          }),
          executionsTable.metricSuccessfulRequestLatency({
            dimensionsMap: { Operation: 'UpdateItem', TableName: executionsTable.tableName },
            statistic: 'Average',
            label: 'UpdateItem Latency (avg)',
            color: cloudwatch.Color.GREEN,
          }),
        ],
      })
    );

    // Row 4: API Gateway and EventBridge
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Requests',
        width: 12,
        left: [
          api.metricCount({ statistic: 'Sum', label: 'Total Requests' }),
          api.metric('4XXError', {
            statistic: 'Sum',
            label: '4XX Errors',
            color: cloudwatch.Color.ORANGE,
          }),
          api.metric('5XXError', {
            statistic: 'Sum',
            label: '5XX Errors',
            color: cloudwatch.Color.RED,
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway Latency',
        width: 12,
        left: [
          api.metricLatency({ statistic: 'Average', label: 'Latency (avg)' }),
          api.metricLatency({
            statistic: 'p99',
            label: 'Latency (p99)',
            color: cloudwatch.Color.ORANGE,
          }),
        ],
      })
    );

    // Row 5: EventBridge and SQS
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'EventBridge Events',
        width: 12,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'Invocations',
            dimensionsMap: {
              EventBusName: this.eventBus.eventBusName,
            },
            statistic: 'Sum',
            label: 'Events Published',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Events',
            metricName: 'FailedInvocations',
            dimensionsMap: {
              EventBusName: this.eventBus.eventBusName,
            },
            statistic: 'Sum',
            label: 'Failed Invocations',
            color: cloudwatch.Color.RED,
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SQS Queue Metrics',
        width: 12,
        left: [
          llmQueue.metricApproximateNumberOfMessagesVisible({
            statistic: 'Average',
            label: 'LLM Queue Depth',
          }),
          webhookDLQ.metricApproximateNumberOfMessagesVisible({
            statistic: 'Sum',
            label: 'Webhook DLQ Messages',
            color: cloudwatch.Color.ORANGE,
          }),
          deploymentDLQ.metricApproximateNumberOfMessagesVisible({
            statistic: 'Sum',
            label: 'Deployment DLQ Messages',
            color: cloudwatch.Color.RED,
          }),
        ],
      })
    );

    // Row 6: Summary Statistics
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Total PR Executions (24h)',
        width: 6,
        metrics: [
          webhookHandler.metricInvocations({ statistic: 'Sum', period: cdk.Duration.days(1) }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total Errors (24h)',
        width: 6,
        metrics: [
          new cloudwatch.MathExpression({
            expression: 'm1 + m2 + m3 + m4',
            usingMetrics: {
              m1: webhookHandler.metricErrors({ statistic: 'Sum', period: cdk.Duration.days(1) }),
              m2: architectureAgent.metricErrors({
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
              m3: githubIntegration.metricErrors({
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
              m4: deploymentOrchestrator.metricErrors({
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
            },
            label: 'Total Errors',
            color: cloudwatch.Color.RED,
          }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Avg Analysis Duration (1h)',
        width: 6,
        metrics: [
          architectureAgent.metricDuration({
            statistic: 'Average',
            period: cdk.Duration.hours(1),
          }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'DLQ Messages',
        width: 6,
        metrics: [
          new cloudwatch.MathExpression({
            expression: 'm1 + m2',
            usingMetrics: {
              m1: webhookDLQ.metricApproximateNumberOfMessagesVisible({ statistic: 'Sum' }),
              m2: deploymentDLQ.metricApproximateNumberOfMessagesVisible({ statistic: 'Sum' }),
            },
            label: 'Total DLQ Messages',
            color: cloudwatch.Color.RED,
          }),
        ],
      })
    );

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
      value: `https://${dashboardDistribution.distributionDomainName}`,
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

    new cdk.CfnOutput(this, 'CloudWatchDashboardURL', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL',
      exportName: 'PullmintDashboardCloudWatchURL',
    });
  }
}
