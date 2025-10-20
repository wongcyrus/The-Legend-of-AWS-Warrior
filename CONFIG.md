# Configuration Management

This project uses a centralized configuration system to manage environment-specific settings like stack names and AWS regions. This eliminates hardcoded values and makes it easy to work with different environments.

## Configuration Files

### `.env` (Checked into git)
Contains default configuration values that work for the main deployment:

```bash
AWS_REGION=us-east-1
STACK_NAME=CloudProjectMarkerTest
```

### `.env.local` (Git-ignored, optional)
Create this file to override defaults for your local development:

```bash
# Copy .env to .env.local and customize
AWS_REGION=us-west-2
STACK_NAME=MyCustomStackName
```

The `.env.local` file takes precedence over `.env` and is not tracked by git, so you can safely customize it without affecting others.

## How It Works

### Bash Scripts
All bash scripts source the `config.sh` file which:
1. Loads environment variables from `.env.local` or `.env`
2. Provides helper functions for common operations
3. Exports consistent variable names

**Example usage in a script:**
```bash
#!/bin/bash

# Load configuration
source "$(dirname "$0")/config.sh"

# Now you can use:
echo "Stack: $STACK_NAME"
echo "Region: $AWS_REGION"

# Get CloudFormation outputs
table_name=$(get_table_name "PassedTestTable")
```

### JavaScript/Node.js Scripts
The `web-app/scripts/deploy.js` script reads the `.env` file directly and uses those values for AWS CLI commands.

## Updated Scripts

All scripts have been updated to use the centralized configuration:

### Root Scripts
- `deploy.sh` - Main deployment script
- `describe_stack.sh` - Stack information viewer
- `config.sh` - Configuration loader (sourced by other scripts)

### Admin Scripts (`admin/`)
- `list_api_keys.sh` - List API keys from usage plan
- `delete_all_api_keys.sh` - Delete all API keys
- `delete_all_passed_test_items.sh` - Clear PassedTestTable
- `delete_all_failed_test_items.sh` - Clear FailedTestTable
- `export_marks.sh` - Export marks to CSV

### Web App Scripts
- `web-app/scripts/deploy.js` - Deploy web app to S3/CloudFront

## Setup for Different Environments

### Production (CloudProjectMarker)
Create `.env.local`:
```bash
STACK_NAME=CloudProjectMarker
AWS_REGION=us-east-1
```

### Testing (CloudProjectMarkerTest)
The default `.env` already uses `CloudProjectMarkerTest`, so no changes needed.

### Development (Custom Stack)
Create `.env.local`:
```bash
STACK_NAME=MyDevStack
AWS_REGION=us-west-2
```

## Important: samconfig.toml

Don't forget to update `samconfig.toml` to match your `.env` stack name:

```toml
[default.global.parameters]
stack_name = "CloudProjectMarkerTest"  # Should match STACK_NAME in .env
region = "us-east-1"                    # Should match AWS_REGION in .env
```

## Helper Functions in config.sh

### `get_stack_output(key)`
Fetch a CloudFormation output value:
```bash
usage_plan_id=$(get_stack_output "UsagePlanId")
```

### `get_table_name(key)`
Fetch a DynamoDB table name from outputs:
```bash
passed_table=$(get_table_name "PassedTestTable")
```

### `print_config()`
Display current configuration:
```bash
print_config
# Output:
# === Configuration ===
# Stack Name: CloudProjectMarkerTest
# Region: us-east-1
# ====================
```

## Migration Notes

Before this change, the following hardcoded values existed:
- `CloudProjectMarker` in some scripts
- `CloudProjectMarkerTest` in others
- `us-east-1` hardcoded everywhere
- Specific DynamoDB table names with resource IDs

All of these have been replaced with dynamic configuration that:
1. Reads from `.env` or `.env.local`
2. Queries CloudFormation for resource names when needed
3. Fails gracefully with helpful error messages

## Troubleshooting

### Error: "Could not find stack"
- Check your `STACK_NAME` in `.env` or `.env.local`
- Verify the stack exists: `aws cloudformation describe-stacks --stack-name YourStackName`

### Error: "Could not find [Resource] in stack outputs"
- Ensure your CloudFormation template exports the required outputs
- Redeploy the stack if you recently added new outputs

### Scripts using old hardcoded values
If you find a script still using hardcoded values, please update it to:
1. Source `config.sh` (for bash) or read `.env` (for JavaScript)
2. Use `$STACK_NAME` and `$AWS_REGION` instead of hardcoded values
