# Overview
This project deploys [dromedary](https://github.com/stelligent/dromedary) in AWS Lambda with API Gateway as the interface.  It also demonstrates the use of CodePipeline to continuously deliver changes made in the source code.

# Deploy
To provision the AWS resources and deploy the app, just run `gulp launch`

You can run `gulp cfn:wait` to wait for the stack to come up, and then `gulp cfn:status` to get the outputs, including the application URL.

To tear everything down, run `gulp teardown`

By default, the stack name will be **dromedary-serverless*.  You can change this by passing `--stackName=my-stack-name` to any of the above gulp commands.

# Todo
* Get PR approved: (https://github.com/andrew-templeton/cfn-api-gateway-integration-response/pull/2)
* CFN for pipeline to build, test, deploy new lambda, deploy static stuff to S3
