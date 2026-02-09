// Version "Master Sync - V50 NEW TABLES"
// Identique à la V49 mais cible les tables V2

const Airtable = require('airtable');
const axios = require('axios');
const sharp = require('sharp'); 

// --- CONFIGURATION ---
const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

const webflowClient = axios.create({
  baseURL: 'https://api.webflow.com/v2',
  headers: {
    'Authorization': `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

const WF_IDS = {
  products: process.env.WF_COLLECTION_ID_PRODUITS,
  categories: process.env.WF_COLLECTION_ID_CATEGORIES,
  partners: process.env.WF_COLLECTION_ID_PARTENAIRES
};

// --- C'EST ICI QUE TU MODIFIES LES NOMS ---
// Mets exactement le nom de tes onglets Airtable dupliqués
const AIRTABLE_TABLE_PRODUITS = 'Gisement V2';
const AIRTABLE_TABLE_CATEGORIES = 'Categories Produits V2';       // <--- Change le nom ici
const AIRTABLE_TABLE_PARTENAIRES = 'Partenaires V2';  // <--- Change le nom ici
// (Si tu utilises les catégories dans le code pour lire Airtable, ajoute-la aussi, 
// mais souvent on lit juste le champ texte dans Gisement).

// --- HELPER FUNCTIONS (Reste du code identique à la V49) ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// ... (Copie tout le reste du code V49 sans rien changer d'autre)