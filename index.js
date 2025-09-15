const core = require('@actions/core');
const fs = require('fs');
const tencentcloud = require('tencentcloud-sdk-nodejs');

/*
EdgeOne deployment action - simplified: always upload PEM cert to Tencent SSL, then deploy to EdgeOne.
Inputs (action.yml):
- secret-id (required)
- secret-key (required)
- fullchain-file (required)
- key-file (required)
- eo-site-id (required)
- eo-domains (required)
- eo-endpoint (optional)
*/

const input = {
  secretId: core.getInput('secret-id', { required: true }),
  secretKey: core.getInput('secret-key', { required: true }),
  fullchainFile: core.getInput('fullchain-file', { required: true }),
  keyFile: core.getInput('key-file', { required: true }),
  eoSiteId: core.getInput('eo-site-id', { required: true }),
  eoDomains: core.getInput('eo-domains', { required: true }),
  eoEndpoint: core.getInput('eo-endpoint') || process.env.EO_ENDPOINT || 'teo.tencentcloudapi.com',
};

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (e) {
    core.setFailed('Failed to read file ' + path + ': ' + e.message);
    throw e;
  }
}

const sharedClientConfig = {
  credential: {
    secretId: input.secretId,
    secretKey: input.secretKey,
  },
  region: '',
};

async function uploadCertificate(certPem, keyPem) {
  core.info('Uploading certificate to Tencent SSL service...');
  const SslClient = tencentcloud.ssl.v20191205.Client;
  const sslClient = new SslClient({
    ...sharedClientConfig,
    profile: {
      httpProfile: {
        endpoint: 'ssl.tencentcloudapi.com',
      },
    },
  });

  const params = {
    CertificatePublicKey: certPem,
    CertificatePrivateKey: keyPem,
    CertificateType: 'SVR', // server cert
  };

  const resp = await sslClient.UploadCertificate(params).catch((e) => {
    core.error('UploadCertificate failed:' + (e.message || e));
    throw e;
  });

  const newCertId = (resp && resp.CertificateId) || (resp && resp.CertId) || resp?.CertificateId || resp?.CertId;
  if (!newCertId) {
    core.setFailed('UploadCertificate did not return a CertificateId');
    throw new Error('UploadCertificate did not return a CertificateId');
  }

  core.info(`Uploaded certificate, CertificateId=${newCertId}`);
  return newCertId;
}

async function deployToEdgeOne(siteId, hosts, certId) {
  core.info('Deploying certificate to EdgeOne...');
  const TeoClient = tencentcloud.teo.v20220901.Client;
  const clientConfig = {
    ...sharedClientConfig,
    profile: {
      httpProfile: {
        endpoint: input.eoEndpoint,
      },
    },
  };

  // Normalize hosts array
  const hostsArray = hosts.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (hostsArray.length === 0) {
    throw new Error('No hosts provided in eo-domains input');
  }

  // Build params for ModifyHostsCertificate
  const params = {
    ZoneId: siteId,
    Hosts: hostsArray,
    Mode: 'sslcert',
    ServerCertInfo: [{ CertId: certId }]
  };

  core.debug('ModifyHostsCertificate params: ' + JSON.stringify(params));

  try {
    if (TeoClient) {
      const client = new TeoClient(clientConfig);
      const resp = await client.ModifyHostsCertificate(params);
      core.info('ModifyHostsCertificate success: ' + JSON.stringify(resp));
      return resp;
    } else {
      // Fallback to common client request
      const common = new tencentcloud.common.CommonClient(clientConfig);
      const resp = await common.request('ModifyHostsCertificate', params, '2022-09-01');
      core.info('ModifyHostsCertificate success (common client): ' + JSON.stringify(resp));
      return resp;
    }
  } catch (err) {
    core.error('ModifyHostsCertificate failed: ' + (err.message || err));
    throw err;
  }
}

async function main() {
  try {
    const certPem = readFile(input.fullchainFile);
    const keyPem = readFile(input.keyFile);

    const certId = await uploadCertificate(certPem, keyPem);

    const resp = await deployToEdgeOne(input.eoSiteId, input.eoDomains, certId);
    core.info('EdgeOne deploy response: ' + JSON.stringify(resp));
  } catch (e) {
    core.error(e.stack || e.message || e);
    core.setFailed(e.message || String(e));
    process.exit(1);
  }
}

main();
