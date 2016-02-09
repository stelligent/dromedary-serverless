process.env.AWS_DEFAULT_REGION = 'us-west-2'
process.env.DROMEDARY_DDB_TABLE_NAME = 'dromedary_dev_casey'

var lambdaAdapter = require('./lambda-adapter.js');
var dromedary = require('dromedary');
exports.handler = lambdaAdapter.bind(dromedary)


