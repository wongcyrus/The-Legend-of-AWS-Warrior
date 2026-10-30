#!/bin/bash

# Script to switch environments between Production and Exam mode
# Usage:
#   ./switch-env.sh prod   # Switch to Production (CloudProjectMarker, Game enabled)
#   ./switch-env.sh exam   # Switch to Exam Mode (CloudProjectMarkerExam, Tasks only)
#   ./switch-env.sh status # Show current active environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-status}"

show_status() {
    echo "=== Current Environment Status ==="
    if [ -f "$SCRIPT_DIR/.env.local" ]; then
        source "$SCRIPT_DIR/.env.local"
        echo "Active config: .env.local"
    else
        source "$SCRIPT_DIR/.env"
        echo "Active config: .env (defaults)"
    fi
    echo "Stack Name:  ${STACK_NAME:-CloudProjectMarker}"
    echo "AWS Region:  ${AWS_REGION:-us-east-1}"
    echo "Exam Mode:   ${REACT_APP_EXAM_MODE:-false}"
    if [ "${REACT_APP_EXAM_MODE}" = "true" ] || [ "${STACK_NAME}" = "CloudProjectMarkerExam" ]; then
        echo "Mode Type:   Exam Mode (Tasks Grader, 3D Game Disabled)"
        echo "Web App URL: https://d2pvxxx1kpyhth.cloudfront.net"
    else
        echo "Mode Type:   Production (Classic & AWS Warrior V2 Game Enabled)"
        echo "Web App URL: https://d13jdzao0nxn1n.cloudfront.net"
    fi
    echo "=================================="
    echo ""
    echo "To switch environment:"
    echo "  ./switch-env.sh prod   # Switch to Production"
    echo "  ./switch-env.sh exam   # Switch to Exam Mode"
}

case "$TARGET" in
    prod|production)
        echo "Switching to Production environment..."
        cp "$SCRIPT_DIR/.env.production" "$SCRIPT_DIR/.env.local"
        echo "REACT_APP_EXAM_MODE=false" > "$SCRIPT_DIR/web-app/.env.local"

        API_ENDPOINT=$(aws cloudformation describe-stacks \
            --stack-name "CloudProjectMarker" \
            --region "us-east-1" \
            --no-cli-pager \
            --query "Stacks[0].Outputs[?OutputKey=='WebApiEndpoint'].OutputValue" \
            --output text 2>/dev/null || echo "https://rsbekaffzg.execute-api.us-east-1.amazonaws.com/")

        API_ENDPOINT="${API_ENDPOINT%/}"
        echo "export const baseUrl = '${API_ENDPOINT}/Prod/';" > "$SCRIPT_DIR/web-app/src/Constant.js"
        echo "export const baseUrl = '${API_ENDPOINT}/Prod/';" > "$SCRIPT_DIR/web-game/src/constant.js"

        echo "✓ Switched to Production (CloudProjectMarker)"
        echo "  - Web App:      https://d13jdzao0nxn1n.cloudfront.net"
        echo "  - Web API:      ${API_ENDPOINT}/Prod/"
        echo "  - Exam Mode:    Disabled (Games enabled)"
        ;;

    exam)
        echo "Switching to Exam Mode environment..."
        cp "$SCRIPT_DIR/.env.exam" "$SCRIPT_DIR/.env.local"
        echo "REACT_APP_EXAM_MODE=true" > "$SCRIPT_DIR/web-app/.env.local"

        API_ENDPOINT=$(aws cloudformation describe-stacks \
            --stack-name "CloudProjectMarkerExam" \
            --region "us-east-1" \
            --no-cli-pager \
            --query "Stacks[0].Outputs[?OutputKey=='WebApiEndpoint'].OutputValue" \
            --output text 2>/dev/null || echo "https://zc9u1f77fa.execute-api.us-east-1.amazonaws.com/")

        API_ENDPOINT="${API_ENDPOINT%/}"
        echo "export const baseUrl = '${API_ENDPOINT}/Prod/';" > "$SCRIPT_DIR/web-app/src/Constant.js"
        echo "export const baseUrl = '${API_ENDPOINT}/Prod/';" > "$SCRIPT_DIR/web-game/src/constant.js"

        echo "✓ Switched to Exam Mode (CloudProjectMarkerExam)"
        echo "  - Web App:      https://d2pvxxx1kpyhth.cloudfront.net"
        echo "  - Web API:      ${API_ENDPOINT}/Prod/"
        echo "  - Exam Mode:    Enabled (Tasks grader active, games hidden)"
        ;;

    status|-s|--status)
        show_status
        ;;

    *)
        echo "Unknown option: $TARGET"
        echo "Usage: ./switch-env.sh [prod|exam|status]"
        exit 1
        ;;
esac
