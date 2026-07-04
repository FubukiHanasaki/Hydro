process.env.CI = true;
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HYDRO_PROFILE ||= `test-${process.pid}`;
process.env.HYDRO_SMS_ALIYUN_ENABLED ||= '1';
process.env.HYDRO_SMS_ALIYUN_TEST_CODE ||= '123456';

const profileDir = path.resolve(os.homedir(), '.hydro', 'profiles', process.env.HYDRO_PROFILE);
fs.mkdirSync(profileDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'addon.json'), JSON.stringify([
    path.resolve(__dirname, '..', 'packages', 'ui-default'),
    path.resolve(__dirname, '..', 'packages', 'phone-auth'),
], null, 2));

const version = process.versions.node.split('.').map((i) => i.padStart(2, '0'));
version.pop();
if (+version.join('.') < 18.08) throw new Error('Tests only available in NodeJS>=18.8');
require('hydrooj/bin/hydrooj');
require('./main');
