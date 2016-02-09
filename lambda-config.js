module.exports = {
    profile: 'stelligent',
    region: 'us-west-2',
    handler: 'index.handler',
    role: 'arn:aws:iam::324320755747:role/lambda_dynamo',
    functionName: 'Dromedary',
    timeout: 10,
    memorySize: 384,
    runtime: 'nodejs'
}