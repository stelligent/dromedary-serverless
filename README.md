# Overview
This project deploys [dromedary](https://github.com/stelligent/dromedary) in AWS Lambda with API Gateway as the interface.  It also demonstrates the use of CodePipeline to continuously deliver changes made in the source code.

# Pipeline
To setup the pipeline, run `gulp pipeline:up`

To view the status of the pipeline, run `gulp pipeline:status`

To teardown the pipeline, run `gulp pipeline:down`