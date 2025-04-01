require('dotenv').config(); // Cargar variables de entorno
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Clase para interactuar con la API de Backblaze B2
 * Permite crear múltiples instancias con diferentes credenciales
 */
class BackblazeB2 {
  /**
   * Constructor de la clase BackblazeB2
   * @param {Object} options - Opciones de configuración
   * @param {string} options.keyId - ID de la clave de API (por defecto usa B2_KEY_ID de .env)
   * @param {string} options.applicationKey - Clave de aplicación (por defecto usa B2_APPLICATION_KEY de .env)
   * @param {string} options.authUrl - URL de autenticación
   * @param {string} options.defaultBucket - Nombre del bucket por defecto
   */
  constructor(options = {}) {
    this.config = {
      keyId: options.keyId || process.env.B2_KEY_ID,
      applicationKey: options.applicationKey || process.env.B2_APPLICATION_KEY,
      authUrl: options.authUrl || 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account',
      apiUrl: '', // Se obtendrá durante la autenticación
      authorizationToken: '', // Se obtendrá durante la autenticación
      downloadUrl: '', // Se obtendrá durante la autenticación
      defaultBucket: options.defaultBucket || 'cloud-video-store'
    };
  }

  /**
   * Método para autenticarse en Backblaze B2
   * @returns {Promise<boolean>} - true si la autenticación fue exitosa, false en caso contrario
   */
  async authorize() {
    try {
      const authString = Buffer.from(`${this.config.keyId}:${this.config.applicationKey}`).toString('base64');
      const response = await axios.get(this.config.authUrl, {
        headers: {
          'Authorization': `Basic ${authString}`
        }
      });

      const data = response.data;
      this.config.apiUrl = data.apiUrl;
      this.config.authorizationToken = data.authorizationToken;
      this.config.downloadUrl = data.downloadUrl;
      
      console.log('Autenticación exitosa');
      console.log('API URL:', this.config.apiUrl);
      console.log('Token de autorización:', this.config.authorizationToken);
      
      return true;
    } catch (error) {
      console.error('Error en autenticación:', error.response ? error.response.data : error.message);
      return false;
    }
  }

  /**
   * Método para listar buckets
   * @returns {Promise<Array>} - Array de buckets disponibles
   */
  async listBuckets() {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return [];
      }

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_buckets`, {
        accountId: this.config.keyId
      }, {
        headers: {
          'Authorization': this.config.authorizationToken
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

  /**
   * Método para subir un archivo
   * @param {string} bucketId - ID del bucket donde se subirá el archivo
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} filePath - Ruta local del archivo a subir
   * @returns {Promise<Object|null>} - Información del archivo subido o null si hubo error
   */
  async uploadFile(bucketId, fileName, filePath) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      // 1. Obtener URL de upload
      const uploadUrlResponse = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_get_upload_url`, {
        bucketId: bucketId
      }, {
        headers: {
          'Authorization': this.config.authorizationToken
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

  /**
   * Método para descargar un archivo
   * @param {string} bucketName - Nombre del bucket
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} outputPath - Ruta local donde se guardará el archivo
   * @returns {Promise<boolean>} - true si la descarga fue exitosa, false en caso contrario
   */
  async downloadFile(bucketName, fileName, outputPath) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      const response = await axios.get(`${this.config.downloadUrl}/file/${bucketName}/${fileName}`, {
        headers: {
          'Authorization': this.config.authorizationToken
        },
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(true));
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Error al descargar archivo:', error.response ? error.response.data : error.message);
      return false;
    }
  }

  /**
   * Método para listar archivos en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string|null} startFileName - Nombre del archivo desde donde comenzar (para paginación)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Object|null>} - Objeto con archivos listados o null si hubo error
   */
  async listFiles(bucketId, startFileName = null, maxFileCount = 100) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return null;
      }

      const params = { bucketId };
      if (startFileName) {
        params.startFileName = startFileName;
      }
      params.maxFileCount = maxFileCount;

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });
      console.log(`Archivos listados para bucket ${bucketId}:`, response.data.files.length);
      return response.data; // Contiene { files: [], nextFileName: ... }
    } catch (error) {
      console.error('Error al listar archivos:', error.response ? error.response.data : error.message);
      return null;
    }
  }

  /**
   * Método para obtener una URL de descarga con token de autorización
   * @param {string} fileName - Nombre del archivo en B2
   * @param {string} bucketName - Nombre del bucket (opcional, usa el predeterminado si no se proporciona)
   * @returns {Promise<string>} - URL de descarga con token
   */
  async getDownloadUrlWithToken(fileName, bucketName = null) {
    try {
      // Usar el bucket predeterminado si no se proporciona uno
      const bucket = bucketName || this.config.defaultBucket;
      
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken || !this.config.downloadUrl) {
        const authSuccess = await this.authorize();
        if (!authSuccess) {
          throw new Error('No se pudo autenticar con Backblaze B2');
        }
      }

      // Codificar el nombre del archivo para usarlo en la URL
      const encodedFileName = encodeURIComponent(fileName);

      // Construir la URL de descarga con el token de autorización
      const downloadUrl = `${this.config.downloadUrl}/file/${bucket}/${encodedFileName}?Authorization=${this.config.authorizationToken}`;
      
      return downloadUrl;
    } catch (error) {
      console.error('Error al generar URL de descarga:', error.message);
      throw error;
    }
  }

  /**
   * Método para buscar archivos por prefijo en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string} prefix - Prefijo para filtrar archivos (como una carpeta virtual)
   * @param {number} maxFileCount - Número máximo de archivos a listar
   * @returns {Promise<Array>} - Array de archivos que coinciden con el prefijo
   */
  async searchFilesByPrefix(bucketId, prefix, maxFileCount = 100) {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return [];
      }

      const params = { 
        bucketId,
        prefix,
        maxFileCount
      };

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      console.log(`Archivos encontrados con prefijo '${prefix}':`, response.data.files.length);
      return response.data.files;
    } catch (error) {
      console.error(`Error al buscar archivos con prefijo '${prefix}':`, error.response ? error.response.data : error.message);
      return [];
    }
  }

  /**
   * Método para buscar archivos por nombre en un bucket
   * @param {string} bucketId - ID del bucket
   * @param {string} fileName - Nombre o parte del nombre del archivo a buscar
   * @returns {Promise<Array>} - Array de archivos que coinciden con el nombre
   */
  async searchFilesByName(bucketId, fileName) {
    try {
      // Primero obtenemos todos los archivos
      const result = await this.listFiles(bucketId);
      if (!result || !result.files) return [];
      
      // Filtramos por nombre (case insensitive)
      const searchTerm = fileName.toLowerCase();
      const matchingFiles = result.files.filter(file => 
        file.fileName.toLowerCase().includes(searchTerm)
      );
      
      console.log(`Se encontraron ${matchingFiles.length} archivos que coinciden con '${fileName}'`);
      return matchingFiles;
    } catch (error) {
      console.error(`Error al buscar archivos por nombre '${fileName}':`, error.message);
      return [];
    }
  }

  /**
   * Método para listar "carpetas" virtuales en un bucket
   * En B2 no hay carpetas reales, pero podemos simularlas con prefijos y delimitadores
   * @param {string} bucketId - ID del bucket
   * @param {string} folderPath - Ruta de la carpeta (prefijo)
   * @returns {Promise<Object>} - Objeto con carpetas y archivos
   */
  async listFolder(bucketId, folderPath = '') {
    try {
      // Asegurar que estamos autenticados
      if (!this.config.authorizationToken) {
        const authSuccess = await this.authorize();
        if (!authSuccess) return { folders: [], files: [] };
      }

      // Normalizar el path para asegurar que termina con /
      const prefix = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
      const delimiter = '/';

      const params = { 
        bucketId,
        prefix,
        delimiter
      };

      const response = await axios.post(`${this.config.apiUrl}/b2api/v2/b2_list_file_names`, params, {
        headers: {
          'Authorization': this.config.authorizationToken
        }
      });

      // Extraer carpetas (prefijos comunes)
      const folders = response.data.commonPrefixes || [];
      
      // Extraer archivos (solo los que están en este nivel, no en subcarpetas)
      const files = response.data.files || [];

      console.log(`Listado de carpeta '${folderPath}': ${folders.length} carpetas, ${files.length} archivos`);
      return { folders, files };
    } catch (error) {
      console.error(`Error al listar carpeta '${folderPath}':`, error.response ? error.response.data : error.message);
      return { folders: [], files: [] };
    }
  }

  // Getters para acceder a la configuración
  getDownloadUrl() {
    return this.config.downloadUrl;
  }

  getApiUrl() {
    return this.config.apiUrl;
  }

  getAuthToken() {
    return this.config.authorizationToken;
  }
}

// Crear una instancia por defecto para mantener compatibilidad con el código existente
const defaultInstance = new BackblazeB2();

// Exportar la clase y la instancia por defecto
module.exports = {
  // Instancia por defecto para mantener compatibilidad
  authorizeAccount: () => defaultInstance.authorize(),
  listBuckets: () => defaultInstance.listBuckets(),
  uploadFile: (bucketId, fileName, filePath) => defaultInstance.uploadFile(bucketId, fileName, filePath),
  downloadFile: (bucketName, fileName, outputPath) => defaultInstance.downloadFile(bucketName, fileName, outputPath),
  listFiles: (bucketId, startFileName, maxFileCount) => defaultInstance.listFiles(bucketId, startFileName, maxFileCount),
  getDownloadUrl: () => defaultInstance.getDownloadUrl(),
  getApiUrl: () => defaultInstance.getApiUrl(),
  getAuthToken: () => defaultInstance.getAuthToken(),
  getDownloadUrlWithToken: (fileName, bucketName) => defaultInstance.getDownloadUrlWithToken(fileName, bucketName),
  
  // Nuevos métodos de búsqueda
  searchFilesByPrefix: (bucketId, prefix, maxFileCount) => defaultInstance.searchFilesByPrefix(bucketId, prefix, maxFileCount),
  searchFilesByName: (bucketId, fileName) => defaultInstance.searchFilesByName(bucketId, fileName),
  listFolder: (bucketId, folderPath) => defaultInstance.listFolder(bucketId, folderPath),
  
  // Exportar la clase para crear nuevas instancias
  BackblazeB2
};
