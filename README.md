# Overview
This project deploys [dromedary](https://github.com/stelligent/dromedary) in AWS Lambda with API Gateway as the interface.  It also demonstrates the use of CodePipeline to continuously deliver changes made in the source code.

# Prerequisite
You need Node.js installed.  If using a linux machine, you can run `sudo yum install nodejs npm --enablerepo=epel`, or for OS X, check out (nodejs.org)[https://nodejs.org/en/download/].

You'll also want to have gulp installed: `npm install -g gulp`

#Deploy
Be sure to run `npm install` first to install all dependent modules.

To provision the AWS resources and deploy the app, just run `gulp launch`

You can run `gulp cfn:wait` to wait for the stack to come up, and then `gulp cfn:status` to get the outputs, including the application URL.

To tear everything down, run `gulp teardown`

By default, the stack name will be **dromedary-serverless**.  You can change this by passing `--stackName=my-stack-name` to any of the above gulp commands.

# Pipeline

To integrate with GitHub, AWS CodePipeline uses OAuth tokens.  Generate your token at [GitHub](https://github.com/settings/tokens) and ensure you enable the following two scopes:
* `admin:repo_hook`, which is used to detect when you have committed and pushed changes to the repository
* `repo`, which is used to read and pull artifacts from public and private repositories into a pipeline

Bring the pipeline up with `gulp pipeline:up --token=XXXXXXXXXXXXXXXXX`

# Todo
* Get PR approved: (https://github.com/andrew-templeton/cfn-api-gateway-integration-response/pull/2)
* CFN for pipeline to:

 * build - via a lambda that calls `gulp lint test`
 * deploy - via a lambda that runs the app CFNs
 * test - via a lambda that calls `gulp test-functional`
 * production - via a lambda that calls `gulp` to update Route53
