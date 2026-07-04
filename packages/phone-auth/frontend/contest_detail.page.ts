import {
  $, ActionDialog, NamedPage, Notification, addPage, i18n, request,
} from '@hydrooj/ui-default';
import { sendSmsCode, showSmsSentMessage, startSmsCountdown } from './sms';

const page = new NamedPage('contest_detail', () => {
  const $marker = $('.phone-auth-contest-profile[data-required="1"]');
  if (!$marker.length) return;

  const isComplete = () => $marker.attr('data-complete') === '1';
  const profileUrl = $marker.attr('data-profile-url');
  const $body = $marker.find('.phone-auth-contest-dialog > div');
  if (!$body.length || !profileUrl) return;

  const dialog = new ActionDialog({
    $body,
    width: '520px',
    onDispatch(action) {
      if (action !== 'ok') return true;
      return validateRequiredFields();
    },
  });

  function findMissingRequired(includeSmsCode = true) {
    return dialog.$dom.find('input[required], select[required]').toArray()
      .find((element: HTMLInputElement | HTMLSelectElement) => {
        if (!includeSmsCode && $(element).attr('name') === 'smsCode') return false;
        const value = $(element).val();
        return Array.isArray(value) ? !value.length : !`${value || ''}`.trim();
      });
  }

  function validateRequiredFields(includeSmsCode = true) {
    const missing = findMissingRequired(includeSmsCode);
    if (!missing) return true;
    Notification.error(i18n('Please fill in all required fields.'));
    $(missing).focus();
    return false;
  }

  const collectProfile = () => {
    const data: Record<string, any> = { operation: 'save' };
    ['realName', 'birthYear', 'birthMonth', 'school', 'grade', 'phone', 'smsCode'].forEach((name) => {
      const $field = dialog.$dom.find(`[name="${name}"]`);
      if ($field.length) data[name] = $field.val();
    });
    return data;
  };

  dialog.$dom.on('click', '[data-phone-auth-send-sms]', async (ev) => {
    ev.preventDefault();
    if (!validateRequiredFields(false)) return;
    const phone = dialog.$dom.find('[name="phone"]').val();
    if (!phone) {
      Notification.error(i18n('Please fill in phone number.'));
      return;
    }
    const $button = $(ev.currentTarget);
    await sendSmsCode($button, () => request.post(profileUrl, { operation: 'send_sms', phone }), (expireSeconds) => {
      showSmsSentMessage(dialog.$dom, expireSeconds);
      $button.data('phoneAuthLabel', i18n('Resend SMS Code'));
      startSmsCountdown($button);
      dialog.$dom.find('[name="smsCode"]').val('').trigger('focus');
    });
  });
  dialog.$dom.find('[data-phone-auth-send-sms]').prop('disabled', false);

  async function completeProfile() {
    while (!isComplete()) {
      const action = await dialog.open();
      if (action !== 'ok') return false;
      try {
        await request.post(profileUrl, collectProfile());
        $marker.attr('data-complete', '1');
        Notification.success(i18n('Profile updated.'));
        return true;
      } catch (error) {
        Notification.error(error.message || error);
      }
    }
    return true;
  }

  let bypassCodeClick = false;
  document.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement;
    const button = target.closest('[data-contest-code]');
    if (!button || isComplete() || bypassCodeClick) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    if (await completeProfile()) {
      bypassCodeClick = true;
      (button as HTMLButtonElement).click();
      bypassCodeClick = false;
    }
  }, true);

  $(document).on('submit', 'form', async function (ev) {
    if (isComplete()) return;
    if (!$(this).find('input[name="operation"][value="attend"]').length) return;
    if ($(this).find('[data-contest-code]').length) return;
    ev.preventDefault();
    if (await completeProfile()) (this as HTMLFormElement).submit();
  });
});

addPage(page);

export default page;
