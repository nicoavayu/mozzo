const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {};

export const API_BASE_URL = env.VITE_API_URL || 'http://localhost:3000';
export const RESTAURANT_NAME = env.VITE_RESTAURANT_NAME || 'Mozzo';
