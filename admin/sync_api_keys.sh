#!/bin/bash

# Script to synchronize API keys between API Gateway and DynamoDB
# This will:
# 1. Add missing DynamoDB entries for keys that exist in API Gateway
# 2. Remove orphaned DynamoDB entries for keys that don't exist in API Gateway
# Usage: ./sync_api_keys.sh [--dry-run]

set -e

# Load configuration
source "$(dirname "$0")/../config.sh"

DRY_RUN=false
if [ "$1" == "--dry-run" ]; then
    DRY_RUN=true
    echo "=== DRY RUN MODE - No changes will be made ==="
fi

echo "=== Sync API Keys between API Gateway and DynamoDB ==="
echo ""
print_config

# Get the Usage Plan ID and DynamoDB table name from the stack
echo "Fetching stack information..."
STACK_OUTPUT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "Error: Could not find stack '$STACK_NAME'"
    exit 1
fi

USAGE_PLAN_ID=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="UsagePlanId") | .OutputValue')
LOOKUP_TABLE=$(echo "$STACK_OUTPUT" | jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="ApiKeyLookupTable") | .OutputValue')

if [ -z "$USAGE_PLAN_ID" ] || [ "$USAGE_PLAN_ID" == "null" ]; then
    echo "Error: Could not find Usage Plan ID in stack outputs"
    exit 1
fi

if [ -z "$LOOKUP_TABLE" ] || [ "$LOOKUP_TABLE" == "null" ]; then
    echo "Error: Could not find ApiKeyLookupTable in stack outputs"
    exit 1
fi

echo "Usage Plan ID: $USAGE_PLAN_ID"
echo "DynamoDB Table: $LOOKUP_TABLE"
echo ""

# Fetch all API keys from API Gateway usage plan
echo "Fetching API keys from API Gateway usage plan..."
API_KEYS_JSON=$(aws apigateway get-usage-plan-keys \
    --usage-plan-id "$USAGE_PLAN_ID" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json)

# Fetch all items from DynamoDB
echo "Fetching API keys from DynamoDB..."
DYNAMO_ITEMS=$(aws dynamodb scan \
    --table-name "$LOOKUP_TABLE" \
    --region "$AWS_REGION" \
    --no-cli-pager \
    --output json)

# Create temporary files
TEMP_DIR=$(mktemp -d)
APIGW_KEYS_FILE="$TEMP_DIR/apigw_keys.txt"
DYNAMO_KEYS_FILE="$TEMP_DIR/dynamo_keys.txt"

# Extract API Gateway keys with their values (in parallel)
echo "Fetching API key values from API Gateway..."
echo "$API_KEYS_JSON" | jq -r '.items[] | "\(.name)|\(.id)"' | while IFS='|' read -r name id; do
    (
        KEY_VALUE=$(aws apigateway get-api-key \
            --api-key "$id" \
            --region "$AWS_REGION" \
            --include-value \
            --no-cli-pager \
            --query 'value' \
            --output text 2>/dev/null)
        
        if [ -n "$KEY_VALUE" ]; then
            echo "$KEY_VALUE|$name" >> "$APIGW_KEYS_FILE"
        fi
    ) &
    
    if [ $(jobs -r | wc -l) -ge 20 ]; then
        wait -n
    fi
done
wait
echo "✓ Fetched all API key values"
echo ""

# Extract DynamoDB keys
echo "$DYNAMO_ITEMS" | jq -r '.Items[] | "\(.ApiKey.S)|\(.Email.S)"' > "$DYNAMO_KEYS_FILE"

# Sort files
sort -o "$APIGW_KEYS_FILE" "$APIGW_KEYS_FILE" 2>/dev/null || touch "$APIGW_KEYS_FILE"
sort -o "$DYNAMO_KEYS_FILE" "$DYNAMO_KEYS_FILE" 2>/dev/null || touch "$DYNAMO_KEYS_FILE"

ADDED_COUNT=0
DELETED_COUNT=0

# Step 1: Add missing DynamoDB entries for API Gateway keys
echo "=== Step 1: Adding missing DynamoDB entries ==="
while IFS='|' read -r key_value email; do
    if ! grep -q "^$key_value|" "$DYNAMO_KEYS_FILE" 2>/dev/null; then
        echo "Missing in DynamoDB:"
        echo "  Email: $email"
        echo "  Key: $key_value"
        
        if [ "$DRY_RUN" = false ]; then
            # Add to DynamoDB
            TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
            aws dynamodb put-item \
                --table-name "$LOOKUP_TABLE" \
                --item "{\"ApiKey\": {\"S\": \"$key_value\"}, \"Email\": {\"S\": \"$email\"}, \"CreatedAt\": {\"S\": \"$TIMESTAMP\"}}" \
                --region "$AWS_REGION" \
                --no-cli-pager > /dev/null 2>&1
            
            if [ $? -eq 0 ]; then
                echo "  ✓ Added to DynamoDB"
                ADDED_COUNT=$((ADDED_COUNT + 1))
            else
                echo "  ✗ Failed to add"
            fi
        else
            echo "  [DRY RUN] Would add to DynamoDB"
            ADDED_COUNT=$((ADDED_COUNT + 1))
        fi
        echo ""
    fi
done < "$APIGW_KEYS_FILE"

if [ $ADDED_COUNT -eq 0 ]; then
    echo "✓ No missing entries to add"
    echo ""
fi

# Step 2: Remove orphaned DynamoDB entries
echo "=== Step 2: Removing orphaned DynamoDB entries ==="
while IFS='|' read -r key_value email; do
    if ! grep -q "^$key_value|" "$APIGW_KEYS_FILE" 2>/dev/null; then
        echo "Orphaned in DynamoDB:"
        echo "  Email: $email"
        echo "  Key: $key_value"
        
        if [ "$DRY_RUN" = false ]; then
            # Delete from DynamoDB
            aws dynamodb delete-item \
                --table-name "$LOOKUP_TABLE" \
                --key "{\"ApiKey\": {\"S\": \"$key_value\"}}" \
                --region "$AWS_REGION" \
                --no-cli-pager > /dev/null 2>&1
            
            if [ $? -eq 0 ]; then
                echo "  ✓ Deleted from DynamoDB"
                DELETED_COUNT=$((DELETED_COUNT + 1))
            else
                echo "  ✗ Failed to delete"
            fi
        else
            echo "  [DRY RUN] Would delete from DynamoDB"
            DELETED_COUNT=$((DELETED_COUNT + 1))
        fi
        echo ""
    fi
done < "$DYNAMO_KEYS_FILE"

if [ $DELETED_COUNT -eq 0 ]; then
    echo "✓ No orphaned entries to remove"
    echo ""
fi

# Cleanup
rm -rf "$TEMP_DIR"

# Summary
echo "=== Summary ==="
if [ "$DRY_RUN" = true ]; then
    echo "DRY RUN: Would add $ADDED_COUNT entries and delete $DELETED_COUNT entries"
    echo ""
    echo "Run without --dry-run to apply changes"
else
    echo "Added to DynamoDB: $ADDED_COUNT"
    echo "Deleted from DynamoDB: $DELETED_COUNT"
    echo ""
    if [ $ADDED_COUNT -gt 0 ] || [ $DELETED_COUNT -gt 0 ]; then
        echo "✅ Sync complete! Run ./validate_api_keys.sh to verify."
    else
        echo "✅ Already in sync! No changes needed."
    fi
fi
