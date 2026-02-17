// Version "Master Sync - V67 DIRECT LINK"
// Tentative de connexion directe Airtable -> Webflow sans passer par le Proxy Vercel
// Objectif : Éliminer les erreurs de Timeout/Mémoire du serveur intermédiaire

const Airtable = require('airtable');
const axios = require('axios');

// --- 1. CONFIGURATION API ---
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

// --- 2. CONFIGURATION DES TABLES AIRTABLE (V2) ---
const AIRTABLE_TABLE_PRODUITS = 'Gisement'; 
const AIRTABLE_TABLE_PARTENAIRES = 'Partenaires';

// --- 3. CONFIGURATION DES SLUGS WEBFLOW ---
const SLUGS = {
    nom: 'name',
    slug: 'slug',
    statut: 'statut-vente',        
    partenaire: 'partenaire',
    categorie: 'categorie-produit', 
    marque: 'marque-produit',
    ref: 'reference-produit',
    unite: 'unite',
    stock_depart: 'stock-de-depart',
    stock_restant: 'stock-restant',
    info_stock: 'infos-sup-stock',  
    dims: 'dimensions-du-produit',
    desc: 'description',
    prix_vente: 'prix-de-vente',
    prix_neuf: 'prix-du-neuf',
    info_prix: 'info-sup-prix',
    reduction: 'pourcentage-reduction',
    lien: 'lien-vers-l-annonce',
    img_main: 'image-principale',
    img_galerie: 'images-galerie'
};

// --- HELPER FUNCTIONS ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function slugify(text) {
  if (!text) return '';
  return text.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
}

function cleanFields(obj) {
  Object.keys(obj).forEach(key => {
    if (obj[key] === null || obj[key] === undefined || obj[key] === "") {
      delete obj[key];
    }
  });
  return obj;
}

// --- GESTION DES OPTIONS ---
let _collectionSchemaCache = null;

async function getOrAddOptionId(collectionId, fieldSlug, optionName, log) {
    if (!optionName) return null;
    try {
        const res = await webflowClient.get(`/collections/${collectionId}`);
        _collectionSchemaCache = res.data;
        if (!_collectionSchemaCache || !_collectionSchemaCache.fields) return null;
        const field = _collectionSchemaCache.fields.find(f => f.slug === fieldSlug);
        if (!field) return null;
        const currentOptions = field.options || field.validations?.options || [];
        let existingOption = currentOptions.find(o => o.name.toLowerCase() === optionName.toLowerCase());
        if (existingOption) return existingOption.id;
        const newOptions = [...currentOptions, { name: optionName }];
        await webflowClient.patch(`/collections/${collectionId}/fields/${field.id}`, {
            isRequired: field.isRequired, displayName: field.displayName, validations: { options: newOptions }
        });
        await delay(2000);
        const resUpdated = await webflowClient.get(`/collections/${collectionId}`);
        const updatedField = resUpdated.data.fields.find(f => f.slug === fieldSlug);
        const updatedOptionsList = updatedField.validations?.options || updatedField.options || [];
        const newOptionEntry = updatedOptionsList.find(o => o.name.toLowerCase() === optionName.toLowerCase());
        return newOptionEntry ? newOptionEntry.id : null;
    } catch (err) { return null; }
}

async function findOrCreateItem(collectionId, rawName) {
  if (!rawName) return null;
  const name = rawName.toString().trim();
  try {
    const response = await webflowClient.get(`/collections/${collectionId}/items?limit=100`);
    const match = (response.data.items || []).find(i => i.fieldData.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
    const createRes = await webflowClient.post(`/collections/${collectionId}/items`, {
      isArchived: false, isDraft: false, fieldData: { name: name, slug: slugify(name) }
    });
    return createResponse.data.id;
  } catch (err) { return null; }
}

async function getPartnerName(recordId) {
    if (!recordId) return null;
    try {
        const record = await airtableBase(AIRTABLE_TABLE_PARTENAIRES).find(recordId);
        return record.get('Nom Société') || record.get('Nom'); 
    } catch (e) { return null; }
}

// --- MAIN SCRIPT ---

module.exports = async (req, res) => {
  // Plus de gestion de proxy_url ici
  if (req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const records = await airtableBase(AIRTABLE_TABLE_PRODUITS).select({
      filterByFormula: "OR({Status SYNC} = 'A Publier', {Status SYNC} = 'Mise à jour demandée')",
      maxRecords: 5 
    }).firstPage();

    if (records.length === 0) return res.status(200).json({ message: 'Rien à synchroniser.', logs: logs });

    log(`${records.length} produits trouvés.`);

    for (const record of records) {
      const productName = record.get('Nom affiché');
      const webflowId = record.get('Webflow item ID'); 
      const baseSlug = record.get('Slug') || slugify(productName) + '-' + Math.floor(Math.random() * 1000);
      
      log(`\n🔎 TRAITEMENT : ${productName}`);

      let webflowPartnerId = null;
      const partnerLink = record.get('Partenaire');
      if (partnerLink && partnerLink.length > 0) {
           const pName = await getPartnerName(partnerLink[0]);
           webflowPartnerId = await findOrCreateItem(WF_IDS.partners, pName);
      }

      const rawCategories = record.get('Category Produit'); 
      let webflowCategoryIds = [];
      if (rawCategories && Array.isArray(rawCategories)) {
          for (const catName of rawCategories) {
              const cId = await findOrCreateItem(WF_IDS.categories, catName);
              if (cId) webflowCategoryIds.push(cId);
          }
      }

      const statutAirtable = record.get('Statut'); 
      let statutVenteId = null;
      if (statutAirtable) {
          statutVenteId = await getOrAddOptionId(WF_IDS.products, SLUGS.statut, statutAirtable, log);
      }

      // --- MODIFICATION V67 : LIENS DIRECTS AIRTABLE ---
      // On prend l'URL directe (elle dure quelques heures, suffisant pour l'import)
      
      const mainImageAttach = record.get('Image principale');
      const mainImageUrl = (mainImageAttach && mainImageAttach.length > 0) 
          ? mainImageAttach[0].url // DIRECT URL
          : null;
      
      const galleryAttach = record.get('Images galerie') || [];
      const galleryUrls = galleryAttach.map(img => img.url); // DIRECT URL

      if (mainImageUrl) log(`   📸 Image URL (Direct): ${mainImageUrl.substring(0, 30)}...`);

      let fieldData = {};
      fieldData[SLUGS.nom] = productName;
      fieldData[SLUGS.slug] = baseSlug;
      fieldData[SLUGS.marque] = record.get('Marque produit');
      fieldData[SLUGS.ref] = record.get('Référence produit');
      fieldData[SLUGS.unite] = record.get('Unité');
      fieldData[SLUGS.stock_depart] = record.get('Stock de départ');
      fieldData[SLUGS.stock_restant] = record.get('Stock restant');
      fieldData[SLUGS.info_stock] = record.get('Info sup Stock');
      fieldData[SLUGS.dims] = record.get('Dimensions du produit');
      fieldData[SLUGS.desc] = record.get('Description');
      fieldData[SLUGS.prix_vente] = record.get('Prix de vente');
      fieldData[SLUGS.prix_neuf] = record.get('Prix du neuf');
      fieldData[SLUGS.info_prix] = record.get('Info sup Prix');
      fieldData[SLUGS.reduction] = record.get('Pourcentage réduction')?.toString();
      fieldData[SLUGS.lien] = record.get("Lien vers l'annonce");
      
      fieldData[SLUGS.partenaire] = webflowPartnerId;
      if (webflowCategoryIds.length > 0) fieldData[SLUGS.categorie] = webflowCategoryIds;
      fieldData[SLUGS.img_main] = mainImageUrl;
      if (galleryUrls.length > 0) fieldData[SLUGS.img_galerie] = galleryUrls;
      fieldData[SLUGS.statut] = statutVenteId;

      fieldData = cleanFields(fieldData);
      
      let itemId = webflowId;

      try {
          if (!itemId) {
              log("   🚀 Création...");
              const createRes = await webflowClient.post(`/collections/${WF_IDS.products}/items`, {
                  isArchived: false, isDraft: false, fieldData: fieldData
              });
              itemId = createRes.data.id;
              log(`   ✅ SUCCÈS (ID: ${itemId})`);
          } else {
              log("   🚀 Mise à jour...");
              try {
                  await webflowClient.patch(`/collections/${WF_IDS.products}/items/${itemId}`, {
                      isArchived: false, isDraft: false, fieldData: fieldData
                  });
                  log(`   ✅ SUCCÈS.`);
              } catch (updateErr) {
                  if (updateErr.response && updateErr.response.data && updateErr.response.data.code === 'resource_not_found') {
                      log("   ⚠️ Item introuvable. Recréation...");
                      const createRes = await webflowClient.post(`/collections/${WF_IDS.products}/items`, {
                          isArchived: false, isDraft: false, fieldData: fieldData
                      });
                      itemId = createRes.data.id;
                      log(`   ✅ SUCCÈS RECRÉATION (Nouvel ID: ${itemId})`);
                  } else {
                      throw updateErr;
                  }
              }
          }

          await airtableBase(AIRTABLE_TABLE_PRODUITS).update(record.id, {
            "Status SYNC": "Publié",
            "Webflow item ID": itemId,
            "Slug": baseSlug
          });

      } catch (err) {
          const msg = err.response ? JSON.stringify(err.response.data) : err.message;
          log(`   ❌ ECHEC: ${msg}`);
          await airtableBase(AIRTABLE_TABLE_PRODUITS).update(record.id, { "Status SYNC": "Erreur" });
      }
    }

    res.status(200).json({ success: true, logs: logs });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, logs: logs });
  }
};