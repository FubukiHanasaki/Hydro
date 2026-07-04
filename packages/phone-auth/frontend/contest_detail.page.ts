import {
  $, ActionDialog, NamedPage, Notification, i18n, request,
} from '@hydrooj/ui-default';

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
      const missing = dialog.$dom.find('input[required], select[required]').toArray()
        .find((element: HTMLInputElement | HTMLSelectElement) => !$(element).val());
      if (missing) {
        Notification.error(i18n('Please fill in all required fields.'));
        $(missing).focus();
        return false;
      }
      return true;
    },
  });

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
    const phone = dialog.$dom.find('[name="phone"]').val();
    if (!phone) {
      Notification.error(i18n('Please fill in phone number.'));
      return;
    }
    try {
      await request.post(profileUrl, { operation: 'send_sms', phone });
      Notification.success(i18n('SMS verification code has been sent.'));
    } catch (error) {
      Notification.error(error.message || error);
    }
  });

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

export default page;
