require('dotenv').config(); // Cargar variables de entorno
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuración inicial
const config = {
  keyId: process.env.B2_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
  authUrl: 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
  apiUrl: '', // Se obtendrá durante la autenticación
  authorizationToken: '', // Se obtendrá durante la autenticación
  downloadUrl: '' // Se obtendrá durante la autenticación
};

// Función para autenticarse en Backblaze B2
async function authorizeAccount() {
  try {
    const authString = Buffer.from(`${config.keyId}:${config.applicationKey}`).toString('base64');
    const response = await axios.get(config.authUrl, {
      headers: {
        'Authorization': `Basic ${authString}`
      }
    });

    const data = response.data;
    config.apiUrl = data.apiUrl;
    config.authorizationToken = data.authorizationToken;
    config.downloadUrl = data.downloadUrl;
    
    console.log('Autenticación exitosa');
    console.log('API URL:', config.apiUrl);
    console.log('Token de autorización:', config.authorizationToken);
    
    return true;
  } catch (error) {
    console.error('Error en autenticación:', error.response ? error.response.data : error.message);
    return false;
  }
}

// Función para listar buckets
async function listBuckets() {
  try {
    const response = await axios.post(`${config.apiUrl}/b2api/v2/b2_list_buckets`, {
      accountId: config.keyId
    }, {
      headers: {
        'Authorization': config.authorizationToken
      }
    });

    console.log('Buckets disponibles:');
    response.data.buckets.forEach(bucket => {
      console.log(`- ${bucket.bucketName} (${bucket.bucketId})`);
    });
    
    return response.data.buckets;
  } catch (error) {
    console.error('Error al listar buckets:', error.response ? error.response.data : error.message);
    return [];
  }
}

// Función para subir un archivo
async function uploadFile(bucketId, fileName, filePath) {
  try {
    // 1. Obtener URL de upload
    const uploadUrlResponse = await axios.post(`${config.apiUrl}/b2api/v2/b2_get_upload_url`, {
      bucketId: bucketId
    }, {
      headers: {
        'Authorization': config.authorizationToken
      }
    });

    const uploadUrl = uploadUrlResponse.data.uploadUrl;
    const uploadAuthToken = uploadUrlResponse.data.authorizationToken;

    // 2. Leer el archivo
    const fileContent = fs.readFileSync(filePath);
    const fileSize = fs.statSync(filePath).size;
    const sha1 = require('crypto').createHash('sha1').update(fileContent).digest('hex');

    // 3. Subir el archivo
    const uploadResponse = await axios.post(uploadUrl, fileContent, {
      headers: {
        'Authorization': uploadAuthToken,
        'X-Bz-File-Name': encodeURIComponent(fileName),
        'Content-Type': 'b2/x-auto',
        'X-Bz-Content-Sha1': sha1,
        'Content-Length': fileSize
      }
    });

    console.log('Archivo subido exitosamente:', uploadResponse.data);
    return uploadResponse.data;
  } catch (error) {
    console.error('Error al subir archivo:', error.response ? error.response.data : error.message);
    return null;
  }
}

// Función para descargar un archivo
async function downloadFile(bucketName, fileName, outputPath) {
  try {
    const response = await axios.get(`${config.downloadUrl}/file/${bucketName}/${fileName}`, {
      headers: {
        'Authorization': config.authorizationToken
      },
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error al descargar archivo:', error.response ? error.response.data : error.message);
    return null;
  }
}

// Función para listar archivos en un bucket
async function listFiles(bucketId, startFileName = null, maxFileCount = 100) {
    try {
        const params = { bucketId };
        if (startFileName) {
            params.startFileName = startFileName;
        }
        params.maxFileCount = maxFileCount;

        const response = await axios.post(`${config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
            headers: {
                'Authorization': config.authorizationToken
            }
        });
        console.log(`Archivos listados para bucket ${bucketId}:`, response.data.files.length);
        return response.data; // Contiene { files: [], nextFileName: ... }
    } catch (error) {
        console.error('Error al listar archivos:', error.response ? error.response.data : error.message);
        return null;
    }
}


// Ejemplo de uso (eliminado para exportación)
/*
  // 1. Autenticarse
  const authSuccess = await authorizeAccount();
  if (!authSuccess) return;

  // 2. Listar buckets
  const buckets = await listBuckets();
  if (buckets.length === 0) return;

  // 3. Subir un archivo (selecciona un bucket de la lista)
  const bucketId = buckets[0].bucketId;
  const bucketName = buckets[0].bucketName;
  
  // Cambia estos valores por los tuyos
  const fileToUpload = 'test.txt';
  const uploadPath = path.join(__dirname, fileToUpload);
  
  // Crear un archivo de prueba si no existe
  if (!fs.existsSync(uploadPath)) {
    fs.writeFileSync(uploadPath, 'Este es un archivo de prueba para Backblaze B2');
  }
  
  const uploadedFile = await uploadFile(bucketId, fileToUpload, uploadPath);
  if (!uploadedFile) return;

  // 4. Descargar el archivo
  const downloadPath = path.join(__dirname, 'downloaded_' + fileToUpload);
  await downloadFile(bucketName, fileToUpload, downloadPath);
  console.log(`Archivo descargado como: ${downloadPath}`);
*/

// Exportar funciones y configuración relevante
module.exports = {
  authorizeAccount,
  listBuckets, // Podría ser útil
  uploadFile,
  downloadFile,
  listFiles, // Nueva función para listar archivos
  getDownloadUrl: () => config.downloadUrl, // Para construir URLs de video
  getApiUrl: () => config.apiUrl, // Podría ser útil
  getAuthToken: () => config.authorizationToken // Podría ser útil
};
