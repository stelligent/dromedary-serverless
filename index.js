var app = require('dromedary');
var lambdaExpress = require('lambda-express');

exports.handler = function( event, context ) {
    process.env.DROMEDARY_DDB_TABLE_NAME = event.ddbTableName;

    lambdaExpress.toApp(event,context,app);
};


