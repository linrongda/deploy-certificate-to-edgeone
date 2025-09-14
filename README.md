# GitHub Action — Deploy SSL certificate to Tencent EdgeOne

## Usage
```yaml
jobs:
  deploy-to-edgeone:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # If you just commited and pushed your newly issued certificate to this repo in a previous job,
          # use `ref` to make sure checking out the newest commit in this job
          ref: ${{ github.ref }}

      - name: Deploy cert to EdgeOne
        uses: linrongda/deploy-certificate-to-edgeone@v1
        with:
          secret-id: ${{ secrets.TENCENTCLOUD_SECRET_ID }}
          secret-key: ${{ secrets.TENCENTCLOUD_SECRET_KEY }}
          fullchain-file: ${{ env.FILE_FULLCHAIN }}
          key-file: ${{ env.FILE_KEY }}
          eo-site-id: zone-xxxxxx
          eo-domains: |
            example.com
            www.example.com
```

## Permissions
Ensure the API credentials have permissions for:
- QcloudSSLFullAccess
- QcloudTEOFullAccess
