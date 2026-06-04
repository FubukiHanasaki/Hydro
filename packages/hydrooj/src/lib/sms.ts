import { SendSmsError, SystemError, ValidationError } from '../error';
import { Logger } from '../logger';
import system from '../model/system';

const logger = new Logger('sms');

function env(name: string) {
    return process.env[`HYDRO_SMS_ALIYUN_${name}`] || '';
}

export function isAliyunSmsEnabled() {
    return system.get('sms.aliyun.enabled') || ['1', 'true', 'yes', 'on'].includes(env('ENABLED').toLowerCase());
}

function getAliyunSmsConfig() {
    return {
        enabled: isAliyunSmsEnabled(),
        accessKeyId: system.get('sms.aliyun.accessKeyId') || env('ACCESS_KEY_ID'),
        accessKeySecret: system.get('sms.aliyun.accessKeySecret') || env('ACCESS_KEY_SECRET'),
        endpoint: system.get('sms.aliyun.endpoint') || env('ENDPOINT') || 'dypnsapi.aliyuncs.com',
        signName: system.get('sms.aliyun.signName') || env('SIGN_NAME'),
        templateCode: system.get('sms.aliyun.templateCode') || env('TEMPLATE_CODE'),
        codeLength: +(system.get('sms.aliyun.codeLength') || env('CODE_LENGTH') || 6),
        expireSeconds: +(system.get('sms.aliyun.expireSeconds') || env('EXPIRE_SECONDS') || 300),
    };
}

export function normalizePhone(input: string) {
    const value = input.trim().replace(/[\s-]/g, '');
    const mainland = value.match(/^(?:\+?86|0086)?(1[3-9]\d{9})$/);
    if (mainland) return mainland[1];
    if (/^\+?[1-9]\d{5,19}$/.test(value)) return value.replace(/^\+/, '');
    throw new ValidationError('phone');
}

export function maskPhone(phone: string) {
    if (phone.length <= 7) return phone.replace(/\d(?=\d{2})/g, '*');
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function assertOk(body: any, phone: string) {
    if (body?.success === true || body?.Success === true) return body;
    if (body?.code === 'OK' || body?.Code === 'OK') return body;
    throw new SendSmsError(maskPhone(phone), body?.message || body?.Message || body?.code || body?.Code || 'Unknown error');
}

async function createAliyunDypnsClient() {
    const {
        enabled, accessKeyId, accessKeySecret, endpoint,
    } = getAliyunSmsConfig();
    if (!enabled) throw new SystemError('SMS registration is not enabled');
    if (!accessKeyId || !accessKeySecret) {
        throw new SystemError('Aliyun SMS is not configured');
    }
    const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
    const OpenApi = require('@alicloud/openapi-client');
    return new Dypnsapi20170525.default(new OpenApi.Config({
        accessKeyId,
        accessKeySecret,
        endpoint: endpoint || 'dypnsapi.aliyuncs.com',
    }));
}

export async function sendAliyunSmsCode(phone: string, outId: string) {
    const {
        signName, templateCode, codeLength, expireSeconds,
    } = getAliyunSmsConfig();
    if (!signName || !templateCode) throw new SystemError('Aliyun SMS is not configured');
    try {
        const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
        const client = await createAliyunDypnsClient();
        const validTime = expireSeconds || 300;
        const request = new Dypnsapi20170525.SendSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: '86',
            signName,
            templateCode,
            templateParam: JSON.stringify({
                code: '##code##',
                min: Math.max(1, Math.ceil(validTime / 60)).toString(),
            }),
            codeLength: codeLength || 6,
            codeType: 1,
            duplicatePolicy: 1,
            interval: 60,
            validTime,
            outId,
        });
        const response = await client.sendSmsVerifyCode(request);
        return assertOk(response?.body || response, phone);
    } catch (e) {
        logger.error('Failed to send SMS to %s: %s', maskPhone(phone), e.message);
        if (e instanceof SendSmsError) throw e;
        throw new SendSmsError(maskPhone(phone), e.message);
    }
}

export async function verifyAliyunSmsCode(phone: string, verifyCode: string, outId: string) {
    try {
        const Dypnsapi20170525 = require('@alicloud/dypnsapi20170525');
        const client = await createAliyunDypnsClient();
        const request = new Dypnsapi20170525.CheckSmsVerifyCodeRequest({
            phoneNumber: phone,
            countryCode: '86',
            verifyCode,
            caseAuthPolicy: 1,
            outId,
        });
        const response = await client.checkSmsVerifyCode(request);
        const body = assertOk(response?.body || response, phone);
        if (body?.model?.verifyResult !== 'PASS' && body?.Model?.VerifyResult !== 'PASS') return false;
        return true;
    } catch (e) {
        logger.error('Failed to verify SMS for %s: %s', maskPhone(phone), e.message);
        if (e instanceof SendSmsError) throw e;
        throw new SendSmsError(maskPhone(phone), e.message);
    }
}
