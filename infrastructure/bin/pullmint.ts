#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Create webhook stack (Phase 1)
new WebhookStack(app, 'PullmintWebhookStack', {
  env,
  description: 'Pullmint webhook receiver and event routing infrastructure',
  tags: {
    Project: 'Pullmint',
    Environment: process.env.ENVIRONMENT || 'development',
    ManagedBy: 'CDK',
  },
});
