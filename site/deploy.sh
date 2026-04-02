#!/bin/bash
set -e

S3_BUCKET="pullmint-lokeshkaki-com"
CLOUDFRONT_DISTRIBUTION_ID="YOUR_DISTRIBUTION_ID"  # Replace after step 1c
AWS_REGION="us-east-1"

echo "Building site..."
cd "$(dirname "$0")"
npm run build

echo "Uploading static assets to S3 (long cache)..."
aws s3 sync dist/ s3://${S3_BUCKET}/ \
  --region ${AWS_REGION} \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "*.html" \
  --exclude "*.json" \
  --exclude "sitemap*.xml"

echo "Uploading HTML/JSON/sitemap to S3 (no cache)..."
aws s3 sync dist/ s3://${S3_BUCKET}/ \
  --region ${AWS_REGION} \
  --delete \
  --cache-control "public, max-age=0, must-revalidate" \
  --exclude "*" \
  --include "*.html" \
  --include "*.json" \
  --include "sitemap*.xml"

echo "Upload complete."

if [ "$CLOUDFRONT_DISTRIBUTION_ID" != "YOUR_DISTRIBUTION_ID" ]; then
  echo "Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id ${CLOUDFRONT_DISTRIBUTION_ID} \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text
  echo "Cache invalidation in progress (1-5 minutes)."
else
  echo "WARNING: CloudFront distribution ID not set in deploy.sh"
fi

echo "Done. Site: https://pullmint.lokeshkaki.com"
