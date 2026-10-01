const axios = require('axios');
const env = require('../config/env');

const googleMaps = axios.create({
  baseURL: 'https://maps.googleapis.com/maps/api',
  timeout: 8000
});

// Every Maps call needs the key; attaching it here keeps it out of the services.
googleMaps.interceptors.request.use((config) => {
  config.params = { ...config.params, key: env.googleMapsApiKey };
  return config;
});

const isConfigured = () => Boolean(env.googleMapsApiKey);

module.exports = { googleMaps, isConfigured };
