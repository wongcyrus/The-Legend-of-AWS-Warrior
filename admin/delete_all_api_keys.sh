#!/bin/bash

# Script to delete all API keys from the CloudProjectMarker stack's usage plan
# This will remove all API keys, their associations with the usage plan,
# and corresponding entries in the ApiKeyLookupTable DynamoDB table

set -e

# Load configuration
source "$(dirname "$0")/../config.sh"

echo "=== Delete All API Keys and DynamoDB Entries ==="
echo ""
print_config

# Get the API Gateway ID and Usage Plan ID from CloudFormation outputs
echo "Fetching stack information..."
STACK_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager)

USAGE_PLAN_ID=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanId") | .OutputValue')
USAGE_PLAN_NAME=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanName") | .OutputValue // "grader-usage-plan"')
API_KEY_LOOKUP_TABLE=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="ApiKeyLookupTable") | .OutputValue')

if [ -z "$USAGE_PLAN_ID" ] || [ "$USAGE_PLAN_ID" == "null" ]; then
    echo "Error: Could not find Usage Plan ID in stack outputs"
    echo "Please ensure the stack has been deployed with the UsagePlanId output"
    exit 1
fi

if [ -z "$API_KEY_LOOKUP_TABLE" ] || [ "$API_KEY_LOOKUP_TABLE" == "null" ]; then
    echo "Error: Could not find ApiKeyLookupTable in stack outputs"
    echo "Please ensure the stack has been deployed with the ApiKeyLookupTable output"
    exit 1
fi

echo "Usage Plan Name: $USAGE_PLAN_NAME"
echo "Usage Plan ID: $USAGE_PLAN_ID"
echo "API Key Lookup Table: $API_KEY_LOOKUP_TABLE"
echo ""

# Get all API keys in the usage plan
echo "Fetching API keys from usage plan..."
API_KEYS=$(aws apigateway get-usage-plan-keys \
    --usage-plan-id "$USAGE_PLAN_ID" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --query 'items[*].[id,name]' \
    --output text)

if [ -z "$API_KEYS" ]; then
    echo "No API keys found in the usage plan."
    exit 0
fi

# Count the number of API keys
KEY_COUNT=$(echo "$API_KEYS" | wc -l)
echo "Found $KEY_COUNT API key(s) to delete."
echo ""

# Confirmation prompt
read -p "Are you sure you want to delete all $KEY_COUNT API key(s)? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted by user."
    exit 0
fi

echo ""
echo "Starting deletion process..."
echo ""

# Counter for progress
DELETED_COUNT=0
FAILED_COUNT=0
DYNAMODB_DELETED_COUNT=0
DYNAMODB_FAILED_COUNT=0

# Store API key values for DynamoDB cleanup
declare -a API_KEY_VALUES

# Process each API key
while IFS=$'\t' read -r KEY_ID KEY_NAME; do
    echo "Processing: $KEY_NAME (ID: $KEY_ID)"
    
    # Get the actual API key value before deletion
    echo "  → Fetching API key value..."
    API_KEY_VALUE=$(aws apigateway get-api-key \
        --api-key "$KEY_ID" \
        --include-value \
        --region "$AWS_REGION" \
        --no-cli-pager \
        --query 'value' \
        --output text 2>/dev/null)
    
    if [ -n "$API_KEY_VALUE" ] && [ "$API_KEY_VALUE" != "null" ]; then
        API_KEY_VALUES+=("$API_KEY_VALUE")
        echo "  ✓ Retrieved API key value"
    else
        echo "  ✗ Could not retrieve API key value"
    fi
    
    # Remove key from usage plan first
    echo "  → Removing from usage plan..."
    if aws apigateway delete-usage-plan-key \
        --usage-plan-id "$USAGE_PLAN_ID" \
        --key-id "$KEY_ID" \
        --region "$AWS_REGION" \
        --no-cli-pager 2>/dev/null; then
        echo "  ✓ Removed from usage plan"
    else
        echo "  ✗ Failed to remove from usage plan (may already be removed)"
    fi
    
    # Delete the API key itself
    echo "  → Deleting API key..."
    if aws apigateway delete-api-key \
        --api-key "$KEY_ID" \
        --region "$AWS_REGION" \
        --no-cli-pager 2>/dev/null; then
        echo "  ✓ API key deleted successfully"
        DELETED_COUNT=$((DELETED_COUNT + 1))
    else
        echo "  ✗ Failed to delete API key"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
    
    echo ""
done <<< "$API_KEYS"

# Delete entries from DynamoDB ApiKeyLookupTable
echo "=== Cleaning up DynamoDB ApiKeyLookupTable ==="
echo ""

if [ ${#API_KEY_VALUES[@]} -eq 0 ]; then
    echo "No API key values retrieved, skipping DynamoDB cleanup."
else
    echo "Deleting ${#API_KEY_VALUES[@]} item(s) from DynamoDB table: $API_KEY_LOOKUP_TABLE"
    echo ""
    
    for API_KEY_VALUE in "${API_KEY_VALUES[@]}"; do
        echo "Deleting DynamoDB item for API key: ${API_KEY_VALUE:0:10}..."
        
        if aws dynamodb delete-item \
            --table-name "$API_KEY_LOOKUP_TABLE" \
            --key "{\"ApiKey\": {\"S\": \"$API_KEY_VALUE\"}}" \
            --region "$AWS_REGION" \
            --no-cli-pager 2>/dev/null; then
            echo "  ✓ DynamoDB item deleted successfully"
            DYNAMODB_DELETED_COUNT=$((DYNAMODB_DELETED_COUNT + 1))
        else
            echo "  ✗ Failed to delete DynamoDB item"
            DYNAMODB_FAILED_COUNT=$((DYNAMODB_FAILED_COUNT + 1))
        fi
        
        echo ""
    done
fi

echo "=== Summary ==="
echo "API Keys:"
echo "  Successfully deleted: $DELETED_COUNT API key(s)"
if [ $FAILED_COUNT -gt 0 ]; then
    echo "  Failed to delete: $FAILED_COUNT API key(s)"
fi
echo ""
echo "DynamoDB Items:"
echo "  Successfully deleted: $DYNAMODB_DELETED_COUNT item(s)"
if [ $DYNAMODB_FAILED_COUNT -gt 0 ]; then
    echo "  Failed to delete: $DYNAMODB_FAILED_COUNT item(s)"
fi
echo ""
echo "Done!"
