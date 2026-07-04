import {
  $, i18n, Notification, request,
} from '@hydrooj/ui-default';

const DEFAULT_EXPIRE_SECONDS = 300;
const RESEND_COOLDOWN_SECONDS = 60;
const REGISTER_CHECK_URL = '/phone-auth/register/check';
const VALIDATION_DEBOUNCE_MS = 400;
const USERNAME_ALLOWED_RE = /^[A-Za-z0-9_\-\u4E00-\u9FA5]+$/;
const USERNAME_CHINESE_RE = /^[\u4E00-\u9FA5]+$/;

type ValidationState = 'idle' | 'checking' | 'valid' | 'invalid';

function buttonLabel($button: JQuery) {
  return $button.is('input') ? `${$button.val() || ''}` : $button.text();
}

function setButtonLabel($button: JQuery, label: string) {
  if ($button.is('input')) $button.val(label);
  else $button.text(label);
}

function ensureValidationStyles() {
  if (document.getElementById('phone-auth-validation-style')) return;
  const style = document.createElement('style');
  style.id = 'phone-auth-validation-style';
  style.textContent = `
    .phone-auth-field-status { margin-top: -0.35rem; margin-bottom: 0.45rem; }
    .phone-auth-field-status + .help-text { margin-top: 0; }
    .phone-auth-field-status.is-valid { color: #16743a; }
    .phone-auth-field-status.is-invalid { color: #b3261e; }
    .phone-auth-field-status.is-checking { color: #806000; }
    .phone-auth-field-status.inverse.is-valid { color: #8ef3b5; }
    .phone-auth-field-status.inverse.is-invalid { color: #ffb4b4; }
    .phone-auth-field-status.inverse.is-checking { color: #ffd27a; }
  `;
  document.head.append(style);
}

function ensureFieldStatus($form: JQuery, name: string) {
  ensureValidationStyles();
  let $status = $form.find(`[data-phone-auth-status-for="${name}"]`).first();
  if (!$status.length) {
    const $field = $form.find(`[name="${name}"]`).first();
    if (!$field.length) return $();
    const inverse = $field.closest('label').hasClass('inverse') ? ' inverse' : '';
    $status = $(`<p class="help-text${inverse} phone-auth-field-status" data-phone-auth-status-for="${name}"></p>`);
    $field.closest('label').after($status);
  }
  return $status;
}

function setFieldStatus($form: JQuery, name: string, state: ValidationState, message = '') {
  const $status = ensureFieldStatus($form, name);
  if (!$status.length) return;
  $status
    .removeClass('is-idle is-checking is-valid is-invalid')
    .addClass(`is-${state}`)
    .toggle(!!message);
  if (!message) {
    $status.text('');
    return;
  }
  const icon = state === 'valid' ? '✓' : state === 'invalid' ? '✗' : '…';
  $status.text(`${icon} ${message}`);
}

function collectSmsData($form: JQuery, includeSmsCode = false) {
  const data: Record<string, any> = {};
  $form.serializeArray().forEach(({ name, value }) => {
    if (!includeSmsCode && name === 'smsCode') return;
    if (data[name] === undefined) data[name] = value;
    else if (Array.isArray(data[name])) data[name].push(value);
    else data[name] = [data[name], value];
  });
  return data;
}

function capturePasswordValues($form: JQuery) {
  return {
    password: `${$form.find('[name="password"]').first().val() || ''}`,
    verifyPassword: `${$form.find('[name="verifyPassword"]').first().val() || ''}`,
  };
}

function restorePasswordValues($form: JQuery, values: Record<string, string>) {
  Object.entries(values).forEach(([name, value]) => {
    const $input = $form.find(`[name="${name}"]`).first();
    if ($input.length) $input.val(value);
  });
}

function hasStrongPassword(password: string) {
  return password.length >= 8 && password.length <= 255 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function hasValidPhone(phone: string) {
  const value = phone.trim().replace(/[\s-]/g, '');
  return /^(?:\+?86|0086)?1[3-9]\d{9}$/.test(value) || /^\+?[1-9]\d{5,19}$/.test(value);
}

function hasValidUsername(username: string) {
  const length = [...username].length;
  const validLength = USERNAME_CHINESE_RE.test(username)
    ? length >= 2 && length <= 31
    : length >= 3 && length <= 31;
  return USERNAME_ALLOWED_RE.test(username) && validLength;
}

function usernameRuleMessage() {
  return [
    'Username can contain only Chinese characters, letters, numbers, underscores (_), and hyphens (-).',
    'Use 3 to 31 characters; if the username is only Chinese characters, 2 characters are allowed.',
    'Each Chinese character counts as one character.',
  ].join(' ');
}

function focusField($form: JQuery, name?: string) {
  if (!name) return;
  $form.find(`[name="${name}"]`).first().trigger('focus');
}

function notifyFirstInvalidField($form: JQuery) {
  const $status = $form.find('.phone-auth-field-status.is-invalid:visible').first();
  const name = $status.attr('data-phone-auth-status-for');
  const message = $status.text().replace(/^[✓✗…]\s*/, '') || i18n('Please fill in all required fields.');
  Notification.error(message);
  focusField($form, name);
}

function isPhoneRegisterForm($form: JQuery) {
  return `${$form.find('[name="mode"]').first().val() || ''}` === 'phone'
    && !!$form.find('[name="uname"]').length
    && !!$form.find('[name="password"]').length
    && !!$form.find('[name="phone"]').length;
}

function updateUsernameStatus($form: JQuery, notify = false, force = false) {
  const $username = $form.find('[name="uname"]').first();
  if (!$username.length) return true;
  const username = `${$username.val() || ''}`.trim();
  if (!username) {
    setFieldStatus($form, 'uname', force ? 'invalid' : 'idle', force ? i18n('Please enter username.') : '');
    if (notify && force) {
      Notification.error(i18n('Please enter username.'));
      $username.trigger('focus');
    }
    return false;
  }
  if (hasValidUsername(username)) return true;
  const message = usernameRuleMessage();
  setFieldStatus($form, 'uname', 'invalid', i18n(message));
  if (notify) {
    Notification.error(i18n(message));
    $username.trigger('focus');
  }
  return false;
}

function updatePhoneStatus($form: JQuery, notify = false, force = false) {
  const $phone = $form.find('[name="phone"]').first();
  if (!$phone.length) return true;
  const phone = `${$phone.val() || ''}`.trim();
  if (!phone) {
    setFieldStatus($form, 'phone', force ? 'invalid' : 'idle', force ? i18n('Please fill in phone number.') : '');
    if (notify && force) {
      Notification.error(i18n('Please fill in phone number.'));
      $phone.trigger('focus');
    }
    return false;
  }
  if (hasValidPhone(phone)) return true;
  const message = 'Phone number format is invalid.';
  setFieldStatus($form, 'phone', 'invalid', i18n(message));
  if (notify) {
    Notification.error(i18n(message));
    $phone.trigger('focus');
  }
  return false;
}

function updatePasswordStatuses($form: JQuery, notify = false, force = false) {
  const $password = $form.find('[name="password"]').first();
  if (!$password.length) return true;
  const $verify = $form.find('[name="verifyPassword"]').first();
  const password = `${$password.val() || ''}`;
  const verifyPassword = `${$verify.val() || ''}`;
  let ok = true;
  let focusName = '';
  let message = '';
  if (!password) {
    ok = !force;
    setFieldStatus($form, 'password', force ? 'invalid' : 'idle', force ? i18n('Please enter password.') : '');
    if (force) {
      focusName ||= 'password';
      message ||= 'Please enter password.';
    }
  } else if (!hasStrongPassword(password)) {
    ok = false;
    message ||= 'Password must be at least 8 characters and include both letters and numbers.';
    focusName ||= 'password';
    setFieldStatus($form, 'password', 'invalid', i18n(message));
  } else setFieldStatus($form, 'password', 'valid', i18n('Password strength is OK.'));
  if ($verify.length) {
    if (!verifyPassword) {
      ok &&= !force;
      setFieldStatus($form, 'verifyPassword', force ? 'invalid' : 'idle', force ? i18n('Please repeat password.') : '');
      if (force) {
        focusName ||= 'verifyPassword';
        message ||= 'Please repeat password.';
      }
    } else if (password !== verifyPassword) {
      ok = false;
      message ||= "Passwords don't match.";
      focusName ||= 'verifyPassword';
      setFieldStatus($form, 'verifyPassword', 'invalid', i18n("Passwords don't match."));
    } else setFieldStatus($form, 'verifyPassword', 'valid', i18n('Passwords match.'));
  }
  if (!ok && notify) {
    Notification.error(i18n(message || 'Please fill in all required fields.'));
    focusField($form, focusName);
  }
  return ok;
}

function clearRegisterAvailability($form: JQuery) {
  const state = $form.data('phoneAuthRegisterAvailability');
  $form.data('phoneAuthRegisterAvailability', { seq: (state?.seq || 0) + 1 });
}

function applyRegisterAvailability($form: JQuery, result: any, requireAll = true) {
  let usernameOk = !requireAll;
  let phoneOk = !requireAll;
  if (result?.username?.valid) {
    usernameOk = !!result.username.available;
    setFieldStatus($form, 'uname', usernameOk ? 'valid' : 'invalid', i18n(usernameOk
      ? 'Username is available.'
      : 'Username is already taken.'));
  }
  if (result?.phone?.valid) {
    phoneOk = !!result.phone.available;
    setFieldStatus($form, 'phone', phoneOk ? 'valid' : 'invalid', i18n(phoneOk
      ? 'Phone number is available.'
      : 'Phone number is already registered.'));
  }
  return usernameOk && phoneOk;
}

async function checkRegisterAvailability($form: JQuery, requireAll = true) {
  if (!isPhoneRegisterForm($form)) return true;
  const usernameOk = updateUsernameStatus($form, requireAll);
  const phoneOk = updatePhoneStatus($form, requireAll);
  if (requireAll && (!usernameOk || !phoneOk)) return false;
  if (!usernameOk && !phoneOk) return false;
  const uname = `${$form.find('[name="uname"]').first().val() || ''}`.trim();
  const phone = `${$form.find('[name="phone"]').first().val() || ''}`.trim();
  const key = `${uname}\n${phone}`;
  const cached = $form.data('phoneAuthRegisterAvailability');
  if (cached?.key === key && cached.result) return applyRegisterAvailability($form, cached.result, requireAll);
  if (cached?.key === key && cached.promise) return cached.promise;
  const seq = (cached?.seq || 0) + 1;
  if (usernameOk) setFieldStatus($form, 'uname', 'checking', i18n('Checking...'));
  if (phoneOk) setFieldStatus($form, 'phone', 'checking', i18n('Checking...'));
  const promise = request.get(REGISTER_CHECK_URL, { uname, phone }).then((result) => {
    const current = $form.data('phoneAuthRegisterAvailability');
    if (current?.seq !== seq) return false;
    $form.data('phoneAuthRegisterAvailability', { key, result, seq });
    return applyRegisterAvailability($form, result, requireAll);
  }).catch((error) => {
    Notification.error(error.message || error);
    return false;
  });
  $form.data('phoneAuthRegisterAvailability', { key, promise, seq });
  return promise;
}

function scheduleRegisterAvailabilityCheck($form: JQuery) {
  if (!isPhoneRegisterForm($form)) return;
  const timer = $form.data('phoneAuthRegisterValidationTimer');
  if (timer) window.clearTimeout(timer);
  clearRegisterAvailability($form);
  const usernameOk = updateUsernameStatus($form);
  const phoneOk = updatePhoneStatus($form);
  if (!usernameOk && !phoneOk) return;
  $form.data('phoneAuthRegisterValidationTimer', window.setTimeout(() => {
    checkRegisterAvailability($form, false);
  }, VALIDATION_DEBOUNCE_MS));
}

function setupRegisterValidation($form: JQuery) {
  if (!isPhoneRegisterForm($form)) return;
  ['uname', 'password', 'verifyPassword', 'phone'].forEach((name) => ensureFieldStatus($form, name).hide());
  $form.on('input.phone-auth-validation change.phone-auth-validation', '[name="uname"], [name="phone"]', () => {
    scheduleRegisterAvailabilityCheck($form);
  });
  $form.on('input.phone-auth-validation change.phone-auth-validation', '[name="password"], [name="verifyPassword"]', () => {
    updatePasswordStatuses($form);
  });
  updatePasswordStatuses($form);
  scheduleRegisterAvailabilityCheck($form);
}

function validateUsername($form: JQuery, notify = true) {
  const $username = $form.find('[name="uname"]').first();
  if (!$username.length) return true;
  return updateUsernameStatus($form, notify, true);
}

function validatePasswords($form: JQuery, notify = true) {
  return updatePasswordStatuses($form, notify, true);
}

function validatePhone($form: JQuery, notify = true) {
  const $phone = $form.find('[name="phone"]').first();
  if (!$phone.length) return true;
  return updatePhoneStatus($form, notify, true);
}

function validateRequired($form: JQuery, includeSmsCode: boolean) {
  const form = $form.get(0) as HTMLFormElement;
  if (!form?.checkValidity) return true;
  const $smsCode = $form.find('[name="smsCode"]').first();
  const smsRequired = $smsCode.prop('required');
  if (!includeSmsCode) $smsCode.prop('required', false);
  const valid = form.checkValidity();
  if (!valid) {
    if (form.reportValidity) form.reportValidity();
    else Notification.error(i18n('Please fill in all required fields.'));
  }
  if (!includeSmsCode) $smsCode.prop('required', smsRequired);
  return valid;
}

function validateBasicFields($form: JQuery, notify = true) {
  const usernameOk = validateUsername($form, false);
  const passwordOk = validatePasswords($form, false);
  const phoneOk = validatePhone($form, false);
  const valid = usernameOk && passwordOk && phoneOk;
  if (!valid && notify) notifyFirstInvalidField($form);
  return valid;
}

async function validateBeforeSms($form: JQuery, includeSmsCode: boolean, checkAvailability: boolean) {
  const basicOk = validateBasicFields($form);
  const requiredOk = validateRequired($form, includeSmsCode);
  if (!basicOk) return false;
  if (checkAvailability && !await checkRegisterAvailability($form)) return false;
  return requiredOk;
}

function smsSentText(expireSeconds: number) {
  return `${i18n('SMS verification code has been sent.')} ${i18n('Valid for {0} seconds.', expireSeconds)}`;
}

export function showSmsSentMessage($container: JQuery, expireSeconds: number) {
  let $message = $container.find('[data-phone-auth-sms-message]').first();
  if (!$message.length) {
    $message = $('<blockquote class="success" data-phone-auth-sms-message></blockquote>');
    $container.prepend($message);
  }
  $message.text(smsSentText(expireSeconds)).show();
}

export function startSmsCountdown($button: JQuery, seconds = RESEND_COOLDOWN_SECONDS) {
  const existingTimer = $button.data('phoneAuthSmsTimer');
  if (existingTimer) window.clearInterval(existingTimer);
  const label = `${$button.data('phoneAuthLabel') || buttonLabel($button) || i18n('Resend SMS Code')}`;
  $button.data('phoneAuthLabel', label);
  let remain = seconds;
  const update = () => {
    if (remain > 0) {
      $button.prop('disabled', true);
      setButtonLabel($button, `${label} ${remain}s`);
      remain--;
      return;
    }
    window.clearInterval($button.data('phoneAuthSmsTimer'));
    $button.removeData('phoneAuthSmsTimer');
    $button.prop('disabled', false);
    setButtonLabel($button, label);
  };
  update();
  $button.data('phoneAuthSmsTimer', window.setInterval(update, 1000));
}

export async function sendSmsCode(
  $button: JQuery,
  post: () => Promise<any>,
  onSuccess?: (expireSeconds: number, result: any) => void,
) {
  if ($button.data('phoneAuthSending') || $button.prop('disabled')) return;
  const label = buttonLabel($button);
  if (!$button.data('phoneAuthLabel')) $button.data('phoneAuthLabel', label);
  $button.data('phoneAuthSending', true);
  $button.prop('disabled', true);
  setButtonLabel($button, i18n('Sending...'));
  try {
    const result = await post();
    const expireSeconds = Number(result?.expireSeconds) || DEFAULT_EXPIRE_SECONDS;
    onSuccess?.(expireSeconds, result);
    Notification.success(i18n('SMS verification code has been sent.'));
  } catch (error) {
    Notification.error(error.message || error);
    $button.prop('disabled', false);
    setButtonLabel($button, label);
  } finally {
    $button.data('phoneAuthSending', false);
  }
}

async function submitSmsVerification($button: JQuery, post: () => Promise<any>) {
  if ($button.data('phoneAuthSending') || $button.prop('disabled')) return;
  const label = buttonLabel($button);
  $button.data('phoneAuthSending', true);
  $button.prop('disabled', true);
  setButtonLabel($button, i18n('Verifying...'));
  try {
    const result = await post();
    if (result?.url) window.location.href = result.url;
    else window.location.reload();
  } catch (error) {
    Notification.error(error.message || error);
    $button.prop('disabled', false);
    setButtonLabel($button, label);
  } finally {
    $button.data('phoneAuthSending', false);
  }
}

function defaultSubmitButton($form: JQuery, verifyStep: boolean) {
  if (verifyStep) return $form.find('[data-phone-auth-verify-step] [type="submit"]').first();
  return $form.find('[data-phone-auth-send-sms]').first();
}

function enableSmsControls($form: JQuery) {
  $form.find('[data-phone-auth-send-sms], [data-phone-auth-resend-sms], [data-phone-auth-verify-sms]').prop('disabled', false);
}

function mirrorSubmittedProfile($form: JQuery) {
  ['realName', 'birthYear', 'birthMonth', 'school', 'grade'].forEach((name) => {
    const $field = $form.find(`[name="${name}"]`).not('[type="hidden"]').first();
    if (!$field.length) return;
    let $mirror = $form.find(`input[type="hidden"][name="${name}"]`).first();
    if (!$mirror.length) {
      $mirror = $(`<input type="hidden" name="${name}">`);
      $field.before($mirror);
    }
    $mirror.val($field.val() as string);
  });
}

function lockSubmittedProfile($form: JQuery) {
  mirrorSubmittedProfile($form);
  ['realName', 'birthYear', 'birthMonth', 'school', 'grade'].forEach((name) => {
    $form.find(`[name="${name}"]`).not('[type="hidden"]').prop('disabled', true).trigger('vjFormDisableUpdate');
  });
  $form.find('[name="uname"]').filter('input').prop('readonly', true);
  $form.find('[name="phone"]').filter('input').prop('readonly', true);
}

function markFormSent($form: JQuery, expireSeconds: number, focusCode = true) {
  $form.attr('data-phone-auth-sms-sent', '1');
  showSmsSentMessage($form, expireSeconds);
  $form.find('[data-phone-auth-send-step]').hide();
  $form.find('[data-phone-auth-verify-step]').show();
  $form.find('[name="smsCode"]').prop('required', true);
  lockSubmittedProfile($form);
  const $resend = $form.find('[data-phone-auth-resend-sms]').first();
  if ($resend.length) startSmsCountdown($resend);
  if (focusCode) $form.find('[name="smsCode"]').trigger('focus');
}

export function setupSmsForms(root: Document | Element | JQuery = document) {
  const $root = (root as any)?.jquery ? root as JQuery : $(root);
  const $forms = $root.is('[data-phone-auth-sms-form]')
    ? $root
    : $root.find('[data-phone-auth-sms-form]');
  $forms.each((_, element) => {
    const $form = $(element);
    if ($form.data('phoneAuthSmsReady')) return;
    $form.data('phoneAuthSmsReady', true);
    enableSmsControls($form);
    setupRegisterValidation($form);
    if ($form.attr('data-phone-auth-sms-sent') === '1') {
      const expireSeconds = Number($form.attr('data-phone-auth-sms-expire')) || DEFAULT_EXPIRE_SECONDS;
      markFormSent($form, expireSeconds, false);
    }
    $form.on('submit.phone-auth-sms', async (ev) => {
      ev.preventDefault();
      const verifyStep = $form.attr('data-phone-auth-sms-sent') === '1';
      if (!await validateBeforeSms($form, verifyStep, !verifyStep)) return;
      const submitter = (ev.originalEvent as SubmitEvent)?.submitter;
      const $button = $(submitter || defaultSubmitButton($form, verifyStep).get(0));
      if (verifyStep) {
        await submitSmsVerification($button, () => request.post($form.attr('action') || '', $form));
        return;
      }
      const passwords = capturePasswordValues($form);
      await sendSmsCode($button, () => request.post($form.attr('action') || '', collectSmsData($form)).finally(() => {
        restorePasswordValues($form, passwords);
      }), (expireSeconds) => {
        markFormSent($form, expireSeconds);
        restorePasswordValues($form, passwords);
      });
    });
    $form.on('click.phone-auth-sms', '[data-phone-auth-resend-sms]', async (ev) => {
      ev.preventDefault();
      const $button = $(ev.currentTarget);
      if (!await validateBeforeSms($form, false, false)) return;
      const passwords = capturePasswordValues($form);
      await sendSmsCode($button, () => request.post($form.attr('action') || '', collectSmsData($form)).finally(() => {
        restorePasswordValues($form, passwords);
      }), (expireSeconds) => {
        showSmsSentMessage($form, expireSeconds);
        startSmsCountdown($button);
        restorePasswordValues($form, passwords);
        $form.find('[name="smsCode"]').val('').trigger('focus');
      });
    });
  });
}
