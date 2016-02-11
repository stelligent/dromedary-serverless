# Overview
This project deploys [dromedary](https://github.com/stelligent/dromedary) in AWS Lambda with API Gateway as the interface.  It also demonstrates the use of CodePipeline to continuously deliver changes made in the source code.

A dependency exists to dromedary, and requires dromedary be linked via `npm link`

# Deploy
To provision the AWS resources and deploy the app, just run `gulp deploy`

# Pipeline
To setup the pipeline, run `gulp pipeline:up`

To view the status of the pipeline, run `gulp pipeline:status`

To teardown the pipeline, run `gulp pipeline:down`

# Todo
* CFN for pipeline
* SDK calls for api gateway
* pipeline lambda to build, test, deploy new lambda, deploy static stuff to S3
