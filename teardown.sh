#!/bin/bash

# Script to completely and cleanly tear down a CloudProjectMarker stack
# Usage:
#   ./teardown.sh exam            # Cleanly tear down CloudProjectMarkerExam
#   ./teardown.sh test            # Cleanly tear down CloudProjectMarkerTest
#   ./teardown.sh <StackName>     # Cleanly tear down a specific custom stack
#   ./teardown.sh prod            # Cleanly tear down CloudProjectMarker (requires confirmation)
#
# Options:
#   --force / -y                 # Skip confirmation prompts (except production)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
FORCE=false

# Check for flags in arguments
for arg in "$@"; do
    if [ "$arg" = "--force" ] || [ "$arg" = "-y" ]; then
        FORCE=true
    fi
done

# Resolve stack name from alias or argument
case "$TARGET" in
    exam)
        STACK_NAME="CloudProjectMarkerExam"
        ;;
    prod|production)
        STACK_NAME="CloudProjectMarker"
        ;;
    test)
        STACK_NAME="CloudProjectMarkerTest"
        ;;
    --force|-y|"")
        # Default to current active stack from .env.local or .env
        source "$SCRIPT_DIR/config.sh"
        ;;
    *)
        STACK_NAME="$TARGET"
        ;;
esac

export AWS_REGION="${AWS_REGION:-us-east-1}"
export STACK_NAME

echo "=========================================="
echo " CloudProjectMarker Stack Teardown"
echo "=========================================="
echo "Stack Name:  $STACK_NAME"
echo "AWS Region:  $AWS_REGION"
echo "=========================================="

# 1. Verify stack exists
if ! STACK_INFO=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --no-cli-pager 2>&1); then
    echo "Stack '$STACK_NAME' does not exist in region '$AWS_REGION'."
    exit 0
fi

# Retrieve key stack outputs before deletion
get_output() {
    local key="$1"
    echo "$STACK_INFO" | jq -r ".Stacks[0].Outputs[]? | select(.OutputKey==\"$key\") | .OutputValue" 2>/dev/null || echo ""
}

WEB_BUCKET=$(get_output "WebAppS3BucketName")
TEST_BUCKET=$(get_output "TestResultBucket")
VOICE_BUCKET=$(get_output "VoicePracticeAudioBucketName")
VOICE_TABLE=$(get_output "VoicePracticeTableName")
USAGE_PLAN_ID=$(get_output "UsagePlanId")

echo "Identified Stack Resources:"
echo "  - Web S3 Bucket:    ${WEB_BUCKET:-None}"
echo "  - Test S3 Bucket:   ${TEST_BUCKET:-None}"
echo "  - Voice Audio S3:   ${VOICE_BUCKET:-None}"
echo "  - Voice Table:      ${VOICE_TABLE:-None}"
echo "  - API Usage Plan:   ${USAGE_PLAN_ID:-None}"
echo ""

# Safety check for Production stack
if [ "$STACK_NAME" = "CloudProjectMarker" ]; then
    echo "⚠️  WARNING: You are about to tear down the PRODUCTION stack ($STACK_NAME)!"
    read -p "Type '$STACK_NAME' to confirm complete deletion: " CONFIRM_NAME
    if [ "$CONFIRM_NAME" != "$STACK_NAME" ]; then
        echo "Teardown aborted."
        exit 1
    fi
elif [ "$FORCE" = false ]; then
    read -p "Are you sure you want to completely tear down stack '$STACK_NAME'? (yes/no): " CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
        echo "Teardown aborted."
        exit 0
    fi
fi

echo ""
echo "Starting clean teardown..."

# Helper function to empty S3 bucket including all versions and delete markers
empty_bucket() {
    local bucket="$1"
    if [ -z "$bucket" ] || [ "$bucket" = "null" ]; then
        return 0
    fi

    # Check if bucket exists
    if ! aws s3api head-bucket --bucket "$bucket" --region "$AWS_REGION" 2>/dev/null; then
        return 0
    fi

    echo "→ Emptying S3 bucket: $bucket ..."
    aws s3 rm "s3://$bucket" --recursive --region "$AWS_REGION" 2>/dev/null || true

    # Delete versions if versioning was enabled
    local versions
    versions=$(aws s3api list-object-versions --bucket "$bucket" --region "$AWS_REGION" \
        --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects": null}')
    if [ -n "$versions" ] && [ "$versions" != '{"Objects": null}' ] && [ "$versions" != '{"Objects": []}' ]; then
        aws s3api delete-objects --bucket "$bucket" --region "$AWS_REGION" --delete "$versions" >/dev/null 2>&1 || true
    fi

    # Delete delete markers if present
    local markers
    markers=$(aws s3api list-object-versions --bucket "$bucket" --region "$AWS_REGION" \
        --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null || echo '{"Objects": null}')
    if [ -n "$markers" ] && [ "$markers" != '{"Objects": null}' ] && [ "$markers" != '{"Objects": []}' ]; then
        aws s3api delete-objects --bucket "$bucket" --region "$AWS_REGION" --delete "$markers" >/dev/null 2>&1 || true
    fi
    echo "  ✓ Emptied $bucket"
}

# Step 1: Cleanly delete all API Gateway keys in the usage plan
if [ -n "$USAGE_PLAN_ID" ] && [ "$USAGE_PLAN_ID" != "null" ]; then
    echo "→ Removing API Gateway keys from Usage Plan ($USAGE_PLAN_ID)..."
    if [ -f "$SCRIPT_DIR/admin/delete_all_api_keys.sh" ]; then
        echo "yes" | STACK_NAME="$STACK_NAME" AWS_REGION="$AWS_REGION" "$SCRIPT_DIR/admin/delete_all_api_keys.sh" || true
    fi
fi

# Step 2: Empty non-empty S3 buckets so CloudFormation can delete them
empty_bucket "$WEB_BUCKET"
empty_bucket "$TEST_BUCKET"
empty_bucket "$VOICE_BUCKET"

# Step 3: Delete CloudFormation stack
echo "→ Deleting CloudFormation stack '$STACK_NAME'..."
aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$AWS_REGION"

echo "→ Waiting for stack deletion to complete (this may take 2-5 minutes for CloudFront)..."
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$AWS_REGION"
echo "  ✓ CloudFormation stack '$STACK_NAME' deleted successfully."

# Step 4: Clean up any explicitly retained resources (e.g. VoicePracticeTable, VoiceAudioBucket)
if [ -n "$VOICE_BUCKET" ] && [ "$VOICE_BUCKET" != "null" ]; then
    if aws s3api head-bucket --bucket "$VOICE_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
        echo "→ Removing retained S3 bucket: $VOICE_BUCKET ..."
        aws s3 rb "s3://$VOICE_BUCKET" --force --region "$AWS_REGION" 2>/dev/null || true
        echo "  ✓ Removed $VOICE_BUCKET"
    fi
fi

if [ -n "$VOICE_TABLE" ] && [ "$VOICE_TABLE" != "null" ]; then
    if aws dynamodb describe-table --table-name "$VOICE_TABLE" --region "$AWS_REGION" 2>/dev/null >/dev/null; then
        echo "→ Removing retained DynamoDB table: $VOICE_TABLE ..."
        aws dynamodb delete-table --table-name "$VOICE_TABLE" --region "$AWS_REGION" 2>/dev/null || true
        echo "  ✓ Removed $VOICE_TABLE"
    fi
fi

# Step 5: Clean up Lambda log groups for this stack
echo "→ Cleaning up CloudWatch log groups for '$STACK_NAME'..."
LOG_GROUPS=$(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK_NAME}-" \
    --region "$AWS_REGION" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null || echo "")

for lg in $LOG_GROUPS; do
    [ -n "$lg" ] && aws logs delete-log-group --log-group-name "$lg" --region "$AWS_REGION" 2>/dev/null || true
done
echo "  ✓ Log groups cleaned up."

# Step 6: If active environment was torn down, switch back to production
if [ -f "$SCRIPT_DIR/.env.local" ]; then
    ACTIVE_STACK=$(grep "^STACK_NAME=" "$SCRIPT_DIR/.env.local" | cut -d'=' -f2 || echo "")
    if [ "$ACTIVE_STACK" = "$STACK_NAME" ]; then
        echo ""
        echo "Active environment was '$STACK_NAME'. Switching back to Production defaults..."
        "$SCRIPT_DIR/switch-env.sh" prod
    fi
fi

echo ""
echo "=========================================="
echo " ✅ Teardown Complete for '$STACK_NAME'"
echo " All API keys, S3 buckets, and stack resources were cleanly removed."
echo "=========================================="
