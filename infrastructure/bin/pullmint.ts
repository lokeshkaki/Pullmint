#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();

const rawStage = String(app.node.tryGetContext('stage') || process.env.STAGE || 'production')
  .trim()
  .toLowerCase();

if (rawStage !== 'staging' && rawStage !== 'production') {
  throw new Error(
    `Invalid stage "${rawStage}". Expected one of: staging, production (via -c stage=... or STAGE env var).`
  );
}

const stage: 'staging' | 'production' = rawStage;
const stackId = stage === 'production' ? 'PullmintWebhookStack' : 'PullmintStagingStack';

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Create webhook stack (Phase 1)
new WebhookStack(app, stackId, {
  stage,
  env,
  description: `Pullmint ${stage} webhook receiver and event routing infrastructure`,
  tags: {
    Project: 'Pullmint',
    Environment: stage,
    ManagedBy: 'CDK',
  },
});
