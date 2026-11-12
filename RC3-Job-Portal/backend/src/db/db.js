const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require("mongoose");
const { mongoUri, mongoDbName } = require('../config/env');

async function connectDB() {
    await mongoose.connect(mongoUri, { dbName: mongoDbName });

    mongoose.connection.on("error", console.error.bind(console, "connection error:"));

    console.log(`Database Connected: ${mongoose.connection.name}`);
}

module.exports = connectDB;