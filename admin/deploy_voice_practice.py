#!/usr/bin/env python3
"""Prepare an additive voice-practice change set without rebuilding the grader."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import yaml


class CfnLoader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    if tag == "GetAtt" and isinstance(value, str):
        value = value.split(".", 1)
    return {tag if tag in ("Ref", "Condition") else "Fn::" + tag: value}


CfnLoader.add_multi_constructor("!", intrinsic)


def additive_template(deployed, source, backend_uri):
    """Keep all deployed grader code/configuration; add only voice resources."""
    result = json.loads(json.dumps(deployed))
    for section in ("Parameters", "Conditions", "Rules", "Resources", "Outputs"):
        for key, value in source.get(section, {}).items():
            if key.startswith("Voice") or key == "EnableVoicePractice":
                result.setdefault(section, {})[key] = value
    result["Resources"]["VoicePracticeFunction"]["Properties"]["CodeUri"] = backend_uri
    result["Resources"]["ApiGatewayApi"]["Properties"].setdefault("Auth", {})[
        "AddApiKeyRequiredToCorsPreflight"] = False
    result["Description"] = source["Description"]
    result.setdefault("Metadata", {}).setdefault("AWSToolsMetrics", {})["AWSAgentToolkit"] = "aws-cloudformation@3"
    return result


def allowed_changes(changes):
    for entry in changes:
        change = entry["ResourceChange"]
        name = change["LogicalResourceId"]
        if not (name.startswith("Voice") or name == "ApiGatewayApi" or name == "ApiGatewayApiProdStage"
                or name.startswith("ApiGatewayApiDeployment")):
            raise RuntimeError(f"Unexpected non-voice resource change: {name}")
        if change.get("Replacement") == "True" and not name.startswith("ApiGatewayApiDeployment"):
            raise RuntimeError(f"Unexpected resource replacement: {name}")


def run(*args):
    return subprocess.check_output(args, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", required=True)
    parser.add_argument("--artifact-bucket", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--model", default="us.amazon.nova-2-lite-v1:0")
    parser.add_argument("--execute", action="store_true",
                        help="Execute the validated change set; default only prepares it.")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    aws = lambda *values: run("aws", *values, "--region", args.region)
    stack = json.loads(aws("cloudformation", "describe-stacks", "--stack-name", args.stack))["Stacks"][0]
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
        raise RuntimeError("The target stack is not ready for an update")
    artifact_dir = root / ".aws-sam" / "voice-deploy"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["bash", str(root / "admin/package_voice_agent.sh"), args.artifact_bucket],
                   cwd=root, check=True)
    agent_hash = hashlib.sha256((root / ".aws-sam/voice-agent.zip").read_bytes()).hexdigest()
    subprocess.run(["npm", "ci", "--prefix", "src/VoicePractice", "--omit=dev", "--no-audit", "--no-fund"],
                   cwd=root, check=True)
    package = artifact_dir / "voice-api.zip"
    package_root = root / "src/VoicePractice"
    with ZipFile(package, "w", ZIP_DEFLATED) as archive:
        for path in sorted(package_root.rglob("*")):
            if path.is_file() and not path.name.endswith(".test.mjs"):
                archive.write(path, path.relative_to(package_root))
    backend_hash = hashlib.sha256(package.read_bytes()).hexdigest()
    backend_key = f"voice-api/{backend_hash}.zip"
    aws("s3", "cp", str(package), f"s3://{args.artifact_bucket}/{backend_key}", "--sse", "AES256",
        "--only-show-errors")
    deployed = json.loads(aws("cloudformation", "get-template", "--stack-name", args.stack,
                              "--template-stage", "Original"))["TemplateBody"]
    if isinstance(deployed, str):
        deployed = yaml.load(deployed, Loader=CfnLoader)
    source = yaml.load((root / "template.yaml").read_text(), Loader=CfnLoader)
    template = additive_template(deployed, source, f"s3://{args.artifact_bucket}/{backend_key}")
    path = artifact_dir / "template.json"
    path.write_text(json.dumps(template, indent=2))
    subprocess.run(["sam", "validate", "--lint", "--template-file", str(path), "--region", args.region],
                   cwd=root, check=True)
    template_key = f"voice-templates/{hashlib.sha256(path.read_bytes()).hexdigest()}.json"
    aws("s3", "cp", str(path), f"s3://{args.artifact_bucket}/{template_key}", "--sse", "AES256",
        "--only-show-errors")
    parameters = [{"ParameterKey": item["ParameterKey"], "UsePreviousValue": True}
                  for item in stack.get("Parameters", []) if not item["ParameterKey"].startswith("Voice")
                  and item["ParameterKey"] != "EnableVoicePractice"]
    parameters += [{"ParameterKey": key, "ParameterValue": value} for key, value in {
        "EnableVoicePractice": "true", "VoiceAgentCodeBucket": args.artifact_bucket,
        "VoiceAgentCodeKey": f"voice-agent/{agent_hash}.zip", "VoiceModelId": args.model,
    }.items()]
    params = artifact_dir / "parameters.json"
    params.write_text(json.dumps(parameters))
    name = "voice-practice-" + backend_hash[:12] + "-" + agent_hash[:8] + "-" + hashlib.sha256(path.read_bytes()).hexdigest()[:8]
    change_set = json.loads(aws("cloudformation", "create-change-set", "--stack-name", args.stack,
        "--change-set-name", name, "--change-set-type", "UPDATE", "--capabilities", "CAPABILITY_IAM",
        "--template-url", f"https://{args.artifact_bucket}.s3.{args.region}.amazonaws.com/{template_key}",
        "--parameters", f"file://{params}"))["Id"]
    aws("cloudformation", "wait", "change-set-create-complete", "--stack-name", args.stack,
        "--change-set-name", change_set)
    changes = json.loads(aws("cloudformation", "describe-change-set", "--stack-name", args.stack,
                             "--change-set-name", change_set))
    allowed_changes(changes["Changes"])
    for entry in changes["Changes"]:
        resource = entry["ResourceChange"]
        print(resource["Action"], resource["LogicalResourceId"])
    print("Validated change set:", change_set)
    if args.execute:
        aws("cloudformation", "execute-change-set", "--stack-name", args.stack,
            "--change-set-name", change_set)
        aws("cloudformation", "wait", "stack-update-complete", "--stack-name", args.stack)
        print("Voice infrastructure deployed. Existing grader code was preserved.")
    else:
        print("No infrastructure changes executed. Review the change set before execution.")


if __name__ == "__main__":
    main()
