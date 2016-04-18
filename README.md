# Overview
This project deploys [dromedary](https://github.com/stelligent/dromedary) in AWS Lambda with API Gateway as the interface to demonstrate serverless architecture. It also demonstrates the use of CodePipeline with Lambdas to continuously deliver changes made in the source code in a serverless manner. We've also written a three-part blog series on the topic here: [Serverless Delivery: Architecture (Part 1)](http://www.stelligent.com/agile/serverless-delivery-architecture-part-1/), [Serverless Delivery: Bootstrapping the Pipeline (Part 2)](http://www.stelligent.com/agile/serverless-delivery-bootstrapping-the-pipeline-part-2/) and [Serverless Delivery: Orchestrating the Pipeline (Part 3)](http://www.stelligent.com/agile/serverless-delivery-orchestrating-the-pipeline-part-3/).

# Architecture Overview
The application is split into 2 separate parts for deployment:

* **API** - deployed as a Lambda function using API Gateway for the front end.
* **Static Content** - deployed into an S3 bucket with website hosting enabled.

Additionally, a `config.json` file is generated and deployed into the S3 bucket containing the endpoint to use for the API in API Gateway.

![app-overview](docs/app-overview.png)

# Pipeline Overview
The pipeline consists of the following steps:

* **commit** - a commit in GitHub triggers a new CodePipeline job. The source is downloaded from GitHub and then pushed into an S3 bucket as a zip file.
* **npm lambda** - a lambda is executed that downloads the source zip file, runs `npm install` to get he dependencies and then uploads the source+dependencies to S3 as a tarball.
* **gulp lambda(s)** - a lambda is executed that downloads the source+dependencies tarball from S3, extracts it, then runs a gulp task

The details of what happens in the gulp task is completely owned by the `gulpfile.js` in the source code.  This provides decoupling of the pipeline from the app and allows the pipeline template to be used by any gulp project.

![pipeline-overview](docs/pipeline-overview.png)

Here's a sample of what the pipeline looks like in AWS CodePipeline console:

![pipeline-example](docs/codepipeline.png)


# Launching Pipeline

To integrate with GitHub, AWS CodePipeline uses OAuth tokens.  Generate your token at [GitHub](https://github.com/settings/tokens) and ensure you enable the following two scopes:
* `admin:repo_hook`, which is used to detect when you have committed and pushed changes to the repository
* `repo`, which is used to read and pull artifacts from public and private repositories into a pipeline

You can launch via the console: [![Launch Pipeline stack](https://s3.amazonaws.com/stelligent-training-public/public/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-west-2#cstack=sn~dromedary-serverless|turl~https://s3-us-west-2.amazonaws.com/serverless-pipeline/master.json)

Or you can launch by using `gulp` in this repo:

* **PREREQUISITES -** You need Node.js installed.
  * Install Node.js: `sudo yum install nodejs npm --enablerepo=epel` (For OS X, check out [nodejs.org](https://nodejs.org/en/download/))
  * Update NPM: `curl -L https://npmjs.org/install.sh | sudo sh`
  * Install Gulp: `sudo npm install -g gulp`
* Download this repo and then run `npm install` first to install all dependent modules.
* Bring the pipeline up with `gulp pipeline:up --token=XXXXXXXXXXXXXXXXX`
* You can run `gulp pipeline:wait` to wait for the stack to come up, and then `gulp pipeline:status` to get the outputs and `gulp pipeline:stacks` to see what applicaiton stacks the pipeline has currently running.
* To tear everything down, run `gulp pipeline:teardown`
* By default, the stack name will be **dromedary-serverless**.  You can change this by passing `--stackName=my-stack-name` to any of the above gulp commands.

# Development
To publish pipeline template/lambda changes, run `gulp publish`.  You may want to choose a different bucket to publish the templates and lambda code to via the `--templateBucket` argument.

# Todo
* Tighten up IAM policies in CFN
