// src/cloudinary.js or just cloudinary.js

const cloudinary = require("cloudinary").v2;
require("dotenv").config(); // Load from .env

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
