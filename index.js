const core = require('@actions/core');
const fs = require('fs');
const tencentcloud = require('tencentcloud-sdk-nodejs');

/*
Tencent Cloud SSL deployment action
Inputs (action.yml):
- secret-id (required)
- secret-key (required)
- fullchain-file (required)
- key-file (required)
- cdn-domains (required)
*/

const input = {
  secretId: core.getInput('secret-id', { required: true }),
  secretKey: core.getInput('secret-key', { required: true }),
  fullchainFile: core.getInput('fullchain-file', { required: true }),
  keyFile: core.getInput('key-file', { required: true }),
  cdnDomains: core.getInput('cdn-domains', { required: true }),
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
  const SSLClient = tencentcloud.ssl.v20191205.Client;
  const sslClient = new SSLClient({
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
  };

  const resp = await sslClient.UploadCertificate(params).catch((e) => {
    core.error('UploadCertificate failed:' + (e.message || e));
    throw e;
  });

  const newCertId = resp?.CertificateId;
  if (!newCertId) {
    core.setFailed('UploadCertificate did not return a CertificateId');
    throw new Error('UploadCertificate did not return a CertificateId');
  }

  core.info(`Uploaded certificate, CertificateId=${newCertId}`);
  return newCertId;
}

async function queryCdnDomainCerts(domains) {
  core.info('Querying CDN domain certificate bindings...');
  const CDNClient = tencentcloud.cdn.v20180606.Client;
  const cdnClient = new CDNClient({
    ...sharedClientConfig,
    profile: {
      httpProfile: {
        endpoint: 'cdn.tencentcloudapi.com',
      },
    },
  });

  const params = {
    Offset: 0,
    Limit: 1000,
    Filters: [
      {
        Name: 'domain',
        Value: domains,
      },
    ],
  };

  try {
    const data = await cdnClient.DescribeDomainsConfig(params);
    core.info('Success: DescribeDomainsConfig');
    core.debug(JSON.stringify(data));

    const res = (data.Domains || []).map((domain) => ({
      domain: domain.Domain,
      certId: domain.Https?.CertInfo?.CertId,
    }));
    core.debug(JSON.stringify(res));
    return res;

  } catch (err) {
    core.error(err.stack || err.message || err);
    core.setFailed(err.message || String(err));
    throw err;
  }
}

async function updateCert(oldCertId, newCertId) {
  const client = new tencentcloud.ssl.v20191205.Client({
    ...sharedClientConfig,
    profile: {
      httpProfile: {
        endpoint: 'ssl.tencentcloudapi.com',
      },
    },
  });

  const params = {
    OldCertificateId: oldCertId,
    ResourceTypes: ['cdn', 'teo'],
    CertificateId: newCertId,
    ExpiringNotificationSwitch: 1,
  };

  try {
    const data = await client.UpdateCertificateInstance(params);
    core.info('Success: UpdateCertificateInstance ' + oldCertId + ' -> ' + newCertId);
    core.debug(JSON.stringify(data));
  } catch (err) {
    core.error(err.stack || err.message || err);
    core.setFailed(err.message || String(err));
    throw err;
  }

  for (let i = 1; i <= 60; i++) {
    core.info(`Waiting for update task to complete... (${i}/60)`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const data = await client.UpdateCertificateInstance(params);
      core.debug(JSON.stringify(data));
      const isDone = (data.DeployRecordId >= 0);
      if (isDone) {
        core.info('Update task completed');
        return;
      }
    } catch (err) {
      core.error(err.stack || err.message || err);
      core.setFailed(err.message || String(err));
      throw err;
    }
  }

  core.error('Update task timeout');
}

const DELETE_STATUS_MAP = {
  0: 'In progress',
  1: 'Completed',
  2: 'Failed',
  3: 'Unauthorized, need `SSL_QCSLinkedRoleInReplaceLoadCertificate` role',
  4: 'Failed because of cert is using by other resources',
  5: 'Internal timeout',
};

async function deleteCertificates(certIds) {
  const client = new tencentcloud.ssl.v20191205.Client({
    ...sharedClientConfig,
    profile: {
      httpProfile: {
        endpoint: 'ssl.tencentcloudapi.com',
      },
    },
  });

  const params = {
    CertificateIds: certIds,
    IsSync: true,
  };

  let taskIds;
  try {
    const data = await client.DeleteCertificates(params);
    core.info('Success: DeleteCertificates');
    core.debug(JSON.stringify(data));

    const certTaskIds = data.CertTaskIds || [];
    core.debug(JSON.stringify(certTaskIds));
    taskIds = certTaskIds.map((x) => x.TaskId);

  } catch (err) {
    core.error(err.stack || err.message || err);
    core.setFailed(err.message || String(err));
    throw err;
  }

  for (let i = 1; i <= 60; i++) {
    core.info(`Waiting for delete task to complete... (${i}/60)`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const data = await client.DescribeDeleteCertificatesTaskResult({ TaskIds: taskIds });
      core.info('Success: DescribeDeleteCertificatesTaskResult');
      core.debug(JSON.stringify(data));

      const tasks = data.DeleteTaskResult || [];
      core.debug(
        tasks
          .map((task) =>
            [
              task.TaskId,
              task.CertId,
              DELETE_STATUS_MAP[task.Status] || task.Status,
              task.Error || '',
              (task.Domains || []).join(','),
            ].join('\t')
          )
          .join('\n')
      );

      const isDone = tasks.every((x) => x.Status !== 0);
      if (isDone) {
        core.info('Delete task completed');
        return;
      }
    } catch (err) {
      core.error(err.stack || err.message || err);
      core.setFailed(err.message || String(err));
      throw err;
    }
  }

  core.error('Delete task timeout');
}

async function main() {
  try {
    const certPem = readFile(input.fullchainFile);
    const keyPem = readFile(input.keyFile);

    const certId = await uploadCertificate(certPem, keyPem);
    const domains = Array.from(new Set(input.cdnDomains.split(/\s+/).filter((x) => x)));
    const domainCerts = await queryCdnDomainCerts(domains);
    const oldCertIds = Array.from(new Set(domainCerts.map((x) => x.certId).filter(Boolean)));

    for (const oldCertId of oldCertIds) {
      await updateCert(oldCertId, certId);
    }
    await deleteCertificates(oldCertIds);

  } catch (e) {
    core.error(e.stack || e.message || e);
    core.setFailed(e.message || String(e));
    process.exit(1);
  }
}

main();
