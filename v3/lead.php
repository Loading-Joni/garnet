<?php
/**
 * lead.php — приём заявок с LeadForm для виртуального хостинга (Timeweb и любой с PHP 7.4+).
 *
 * Что делает:
 *   1. принимает POST с JSON (или обычную форму), только со своего сайта;
 *   2. ограничивает частоту запросов с одного IP (файлы, без базы данных);
 *   3. молча отбрасывает ботов (заполненное скрытое поле website);
 *   4. проверяет имя, телефон (+7 и 10 цифр), согласие на обработку ПДн;
 *   5. отправляет заявку по двум каналам:
 *      - почта (mail() хостинга) — ОСНОВНОЙ, надёжный канал, если задан email_to;
 *      - Telegram (Bot API) — дополнительный, с коротким таймаутом (3 с на соединение, 5 с всего):
 *        с российского хостинга api.telegram.org может не отвечать, тогда помогает прокси telegram_api;
 *      сбой Telegram не ломает заявку, если ушло письмо;
 *   6. отвечает JSON: {"ok":true}, если доставлено хотя бы в один канал, иначе {"ok":false,"error":"…"};
 *   7. пишет сбои каналов (без персональных данных) в лог вне веб-корня: ../lead-data/lead.log.
 *
 * Куда класть: public/lead.php в проекте Next.js → после сборки окажется в out/lead.php →
 * на хостинге в public_html/lead.php.
 *
 * Адреса почты, токен бота и chat_id НЕ хранятся в этом файле. Конфиг ищется по порядку:
 *   1. путь из переменной окружения LEAD_CONFIG;
 *   2. ../lead-config.php — уровнем выше public_html, вне веб-корня (ОСНОВНОЙ вариант);
 *   3. ./.lead-config.php — рядом с lead.php (ЗАПАСНОЙ, если выше public_html писать нельзя).
 *      Это PHP-файл, который только возвращает массив: при прямом запросе сервер его выполнит
 *      и ничего не покажет, поэтому токен не утечёт. Но вариант 2 надёжнее.
 * Образец конфига — lead-config.example.php, пошагово — README.md рядом.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const MAX_BODY_BYTES = 16384;
const TELEGRAM_CONNECT_TIMEOUT = 3; // с
const TELEGRAM_TOTAL_TIMEOUT = 5;   // с
const LOG_MAX_BYTES = 200000;

// Человек мог закрыть вкладку — заявку всё равно доотправляем
ignore_user_abort(true);
@set_time_limit(25);

/** @param array<string, mixed> $body */
function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Лог сбоев доставки (без имён и телефонов). Первый вызов с $setFile задаёт путь.
 * Файл вне public_html; при росте больше ~200 КБ старый уходит в lead.log.1.
 */
function lead_log(string $message, ?string $setFile = null): void
{
    static $file = '';
    if ($setFile !== null) {
        $file = $setFile;
        return;
    }
    error_log('lead.php: ' . $message);
    if ($file === '') {
        return;
    }
    $size = @filesize($file);
    if (is_int($size) && $size > LOG_MAX_BYTES) {
        @rename($file, $file . '.1');
    }
    @file_put_contents($file, date('Y-m-d H:i:s') . ' ' . $message . "\n", FILE_APPEND | LOCK_EX);
}

/** @return array<string, mixed> */
function load_config(): array
{
    $candidates = [];
    $env = getenv('LEAD_CONFIG');
    if (is_string($env) && $env !== '') {
        $candidates[] = $env;
    }
    $candidates[] = dirname(__DIR__) . '/lead-config.php';
    $candidates[] = __DIR__ . '/.lead-config.php';

    foreach ($candidates as $path) {
        // @ — на хостинге с open_basedir проверка чужого пути даёт предупреждение
        if (@is_file($path) && @is_readable($path)) {
            $config = require $path;
            if (is_array($config)) {
                return $config;
            }
        }
    }
    return [];
}

/** @param mixed $value */
function clean_text($value, int $maxLength): string
{
    if (!is_string($value) && !is_numeric($value)) {
        return '';
    }
    $text = (string) $value;
    if (!mb_check_encoding($text, 'UTF-8')) {
        return '';
    }
    // Управляющие символы (кроме перевода строки) — вон
    $text = (string) preg_replace('/[\x00-\x09\x0B-\x1F\x7F]/u', '', $text);
    $text = trim($text);
    return mb_substr($text, 0, $maxLength);
}

function client_ip(): string
{
    // REMOTE_ADDR — единственный адрес, который нельзя подделать заголовком.
    // Если хостинг за прокси и REMOTE_ADDR у всех одинаковый — включите trust_forwarded в конфиге.
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
}

/** true — лимит не превышен. Хранит отметки времени запросов по хэшу IP. */
function rate_limit_ok(string $dir, string $ip, int $max, int $window): bool
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        return true; // не смогли создать папку — не блокируем людей
    }
    $file = rtrim($dir, '/') . '/rl-' . sha1($ip) . '.json';
    $handle = @fopen($file, 'c+');
    if ($handle === false) {
        return true;
    }
    $allowed = true;
    if (flock($handle, LOCK_EX)) {
        $raw = stream_get_contents($handle);
        $stamps = is_string($raw) && $raw !== '' ? json_decode($raw, true) : [];
        $stamps = is_array($stamps) ? $stamps : [];
        $now = time();
        $stamps = array_values(array_filter($stamps, static function ($t) use ($now, $window): bool {
            return is_int($t) && $t > $now - $window;
        }));
        if (count($stamps) >= $max) {
            $allowed = false;
        } else {
            $stamps[] = $now;
        }
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, (string) json_encode($stamps));
        fflush($handle);
        flock($handle, LOCK_UN);
    }
    fclose($handle);

    // Изредка чистим старые файлы
    if (mt_rand(1, 50) === 1) {
        foreach ((array) glob(rtrim($dir, '/') . '/rl-*.json') as $old) {
            if (is_string($old) && @filemtime($old) < time() - 86400) {
                @unlink($old);
            }
        }
    }
    return $allowed;
}

/** 10 цифр национального номера или '' */
function normalize_phone(string $phone): string
{
    $digits = (string) preg_replace('/\D/', '', $phone);
    if (strlen($digits) === 11 && ($digits[0] === '7' || $digits[0] === '8')) {
        $digits = substr($digits, 1);
    }
    return strlen($digits) === 10 ? $digits : '';
}

function format_phone(string $d): string
{
    return sprintf('+7 (%s) %s-%s-%s', substr($d, 0, 3), substr($d, 3, 3), substr($d, 6, 2), substr($d, 8, 2));
}

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** POST JSON. Возвращает [HTTP-код, тело] или [0, текст ошибки]. @param array<string, mixed> $data */
function http_post_json(string $url, array $data, int $connectTimeout, int $timeout): array
{
    $json = (string) json_encode($data, JSON_UNESCAPED_UNICODE);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $json,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => $connectTimeout,
        ]);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        if (PHP_VERSION_ID < 80000) {
            curl_close($ch); // с PHP 8 ресурс закрывается сам, а в 8.5 вызов устарел
        }
        return [$code, is_string($body) ? $body : $error];
    }
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/json\r\n",
        'content' => $json,
        'timeout' => $timeout,
        'ignore_errors' => true,
    ]]);
    $previous = ini_get('default_socket_timeout');
    ini_set('default_socket_timeout', (string) $connectTimeout);
    $body = @file_get_contents($url, false, $context);
    ini_set('default_socket_timeout', (string) $previous);
    $code = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
            $code = (int) $m[1];
        }
    }
    return [$code, is_string($body) ? $body : 'request failed'];
}

/** @param array<string, mixed> $config */
function send_telegram(array $config, string $html): bool
{
    $token = (string) ($config['telegram_token'] ?? '');
    $chatIds = $config['telegram_chat_id'] ?? '';
    $chatIds = is_array($chatIds) ? $chatIds : [$chatIds];
    $chatIds = array_filter(array_map('strval', $chatIds), static function (string $id): bool {
        return $id !== '';
    });
    if ($token === '' || count($chatIds) === 0) {
        return false;
    }
    $api = rtrim((string) ($config['telegram_api'] ?? 'https://api.telegram.org'), '/');
    $delivered = false;
    foreach ($chatIds as $chatId) {
        [$code, $body] = http_post_json($api . '/bot' . $token . '/sendMessage', [
            'chat_id' => $chatId,
            'text' => $html,
            'parse_mode' => 'HTML',
            'disable_web_page_preview' => true,
        ], TELEGRAM_CONNECT_TIMEOUT, TELEGRAM_TOTAL_TIMEOUT);
        $decoded = json_decode((string) $body, true);
        if ($code === 200 && is_array($decoded) && ($decoded['ok'] ?? false) === true) {
            $delivered = true;
        } else {
            // Без персональных данных: код, описание ошибки Telegram или сети (таймаут, DNS)
            $description = is_array($decoded) ? (string) ($decoded['description'] ?? '') : mb_substr((string) $body, 0, 200);
            lead_log('telegram failed: HTTP ' . $code . ' ' . $description);
        }
    }
    return $delivered;
}

/** @param array<string, mixed> $config */
function send_email(array $config, string $subject, string $text): bool
{
    $to = trim((string) ($config['email_to'] ?? ''));
    if ($to === '' || !function_exists('mail')) {
        return false;
    }
    $from = trim((string) ($config['email_from'] ?? ''));
    $from = (string) preg_replace('/[\r\n]/', '', $from);
    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
    ];
    if ($from !== '') {
        $headers[] = 'From: ' . $from;
    }
    $encodedSubject = '=?UTF-8?B?' . base64_encode((string) preg_replace('/[\r\n]/', ' ', $subject)) . '?=';
    $ok = @mail($to, $encodedSubject, $text, implode("\r\n", $headers));
    if (!$ok) {
        lead_log('email failed: mail() returned false (проверьте email_from на домене сайта)');
    }
    return $ok;
}

/* ─────────────────────────────── Запрос ─────────────────────────────── */

$config = load_config();
// Время в логе и заявке — по часовому поясу бизнеса
if (!@date_default_timezone_set((string) ($config['timezone'] ?? 'Europe/Moscow'))) {
    date_default_timezone_set('Europe/Moscow');
}

// Папка для счётчиков лимита и лога — вне public_html
$storageDir = (string) ($config['storage_dir'] ?? (dirname(__DIR__) . '/lead-data'));
if (!@is_dir($storageDir) && !@mkdir($storageDir, 0700, true)) {
    $storageDir = rtrim(sys_get_temp_dir(), '/') . '/lead-data-' . substr(sha1(__DIR__), 0, 8);
    @mkdir($storageDir, 0700, true);
}
lead_log('', (string) ($config['log_file'] ?? ($storageDir . '/lead.log')));

$hasTelegram = ($config['telegram_token'] ?? '') !== '' && ($config['telegram_chat_id'] ?? '') !== '';
$hasEmail = trim((string) ($config['email_to'] ?? '')) !== '';
$method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');

// Проверка источника: свой домен + allowed_origins из конфига (например, http://localhost:3000)
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$host = (string) ($_SERVER['HTTP_HOST'] ?? '');
$allowedOrigins = array_map('strval', (array) ($config['allowed_origins'] ?? []));
$originHost = $origin !== '' ? (string) parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '') : '';
$originAllowed = $origin === '' || $originHost === $host || in_array($origin, $allowedOrigins, true);
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Accept');
    header('Vary: Origin');
}

if ($method === 'OPTIONS') {
    http_response_code($originAllowed ? 204 : 403);
    exit;
}

// GET — проверка, что обработчик на месте и настроен (без секретов)
if ($method === 'GET') {
    respond(200, [
        'ok' => true,
        'handler' => 'lead.php',
        'config_found' => $config !== [],
        'telegram' => $hasTelegram,
        'email' => $hasEmail,
    ]);
}

if ($method !== 'POST') {
    header('Allow: GET, POST, OPTIONS');
    respond(405, ['ok' => false, 'error' => 'Метод не поддерживается']);
}

if (!$originAllowed) {
    respond(403, ['ok' => false, 'error' => 'Запрос с чужого сайта']);
}

if (!$hasTelegram && !$hasEmail) {
    lead_log('not configured: config not found or email_to/telegram_token/telegram_chat_id empty');
    respond(500, ['ok' => false, 'error' => 'Обработчик заявок не настроен']);
}

// Тело: JSON или обычная форма
$raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if (strlen($raw) > MAX_BODY_BYTES) {
    respond(413, ['ok' => false, 'error' => 'Слишком большой запрос']);
}
$contentType = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? ''));
$input = strpos($contentType, 'application/json') !== false ? json_decode($raw, true) : $_POST;
if (!is_array($input)) {
    respond(400, ['ok' => false, 'error' => 'Неверный формат запроса']);
}

// Лимит частоты: по умолчанию 5 заявок за 10 минут с одного IP
$rate = (array) ($config['rate_limit'] ?? []);
$ip = client_ip();
if (!empty($config['trust_forwarded']) && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
    $ip = trim(explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
}
if (!rate_limit_ok($storageDir, $ip, (int) ($rate['max'] ?? 5), (int) ($rate['window'] ?? 600))) {
    respond(429, ['ok' => false, 'error' => 'Слишком много заявок подряд. Попробуйте через несколько минут или позвоните нам']);
}

// Ловушка: человек это поле не видит. Боту отвечаем «успех», чтобы он не подбирал обход.
if (clean_text($input['website'] ?? '', 200) !== '') {
    respond(200, ['ok' => true]);
}

// Слишком быстрая отправка (форма открыта меньше N мс) — почти всегда бот
$minElapsed = (int) ($config['min_elapsed_ms'] ?? 1500);
if (isset($input['elapsed']) && is_numeric($input['elapsed']) && (int) $input['elapsed'] < $minElapsed) {
    respond(400, ['ok' => false, 'error' => 'Форма отправлена слишком быстро. Попробуйте ещё раз']);
}

$name = clean_text($input['name'] ?? '', 100);
$phoneDigits = normalize_phone(clean_text($input['phone'] ?? '', 40));
$comment = clean_text($input['comment'] ?? '', 1000);
$consentRaw = $input['consent'] ?? false;
$consent = $consentRaw === true || $consentRaw === 'true' || $consentRaw === '1' || $consentRaw === 'on';
$source = clean_text($input['source'] ?? '', 100);
$page = clean_text($input['page'] ?? '', 500);

$errors = [];
if (mb_strlen($name) < 2) {
    $errors['name'] = 'Укажите имя';
}
if ($phoneDigits === '') {
    $errors['phone'] = 'Укажите телефон: +7 и 10 цифр';
}
if (!$consent) {
    $errors['consent'] = 'Нужно согласие на обработку персональных данных';
}
if ($errors !== []) {
    respond(400, ['ok' => false, 'error' => implode('. ', $errors), 'fields' => $errors]);
}

// UTM и доп. поля (ответы квиза)
$utmLines = [];
foreach ((array) ($input['utm'] ?? []) as $key => $value) {
    $k = clean_text((string) $key, 40);
    if ($k !== '' && (strpos($k, 'utm_') === 0 || $k === 'yclid')) {
        $utmLines[] = $k . '=' . clean_text($value, 200);
    }
}
$extraLines = [];
foreach (array_slice((array) ($input['extra'] ?? []), 0, 30, true) as $key => $value) {
    $k = clean_text((string) $key, 200);
    if (is_array($value)) {
        $v = implode(', ', array_map(static function ($item): string {
            return clean_text($item, 200);
        }, array_slice($value, 0, 20)));
    } elseif (is_bool($value)) {
        $v = $value ? 'да' : 'нет';
    } else {
        $v = clean_text($value, 500);
    }
    if ($k !== '' && $v !== '') {
        $extraLines[] = [$k, $v];
    }
}

/* ─────────────────────────────── Сообщение ─────────────────────────────── */

$timezone = (string) ($config['timezone'] ?? 'Europe/Moscow');
try {
    $now = new DateTimeImmutable('now', new DateTimeZone($timezone));
} catch (Exception $e) {
    $now = new DateTimeImmutable('now');
}
$siteName = clean_text($config['site_name'] ?? ($host !== '' ? $host : 'сайт'), 100);
$phone = format_phone($phoneDigits);

$html = '<b>Новая заявка</b> · ' . h($siteName) . "\n\n";
$html .= '<b>Имя:</b> ' . h($name) . "\n";
$html .= '<b>Телефон:</b> ' . h($phone) . "\n";
if ($comment !== '') {
    $html .= '<b>Комментарий:</b> ' . h($comment) . "\n";
}
foreach ($extraLines as [$k, $v]) {
    $html .= '<b>' . h($k) . ':</b> ' . h($v) . "\n";
}
$html .= "\n";
if ($source !== '') {
    $html .= 'Форма: ' . h($source) . "\n";
}
if ($page !== '') {
    $html .= 'Страница: ' . h($page) . "\n";
}
if ($utmLines !== []) {
    $html .= 'UTM: ' . h(implode(' · ', $utmLines)) . "\n";
}
$html .= 'Время: ' . $now->format('d.m.Y H:i') . "\n";
$html .= 'Согласие на обработку ПДн: получено';
$html = mb_substr($html, 0, 4000);

$text = (string) preg_replace('/<[^>]+>/', '', html_entity_decode($html, ENT_QUOTES | ENT_HTML5, 'UTF-8'));

// Сначала почта (надёжный канал), потом Telegram (может не ответить из РФ — короткий таймаут)
$deliveredEmail = $hasEmail && send_email($config, 'Заявка с сайта ' . $siteName, $text);
$deliveredTelegram = $hasTelegram && send_telegram($config, $html);

// debug => true в конфиге: в ответе видно, какой канал сработал (на время настройки)
$channels = !empty($config['debug']) ? ['channels' => [
    'email' => $hasEmail ? $deliveredEmail : 'not configured',
    'telegram' => $hasTelegram ? $deliveredTelegram : 'not configured',
]] : [];

if ($deliveredTelegram || $deliveredEmail) {
    respond(200, ['ok' => true] + $channels);
}

// Никуда не ушло — сохраняем, чтобы заявка не потерялась (если путь задан в конфиге)
$fallbackLog = (string) ($config['fallback_log'] ?? '');
if ($fallbackLog !== '') {
    $line = json_encode([
        'time' => $now->format(DATE_ATOM),
        'name' => $name,
        'phone' => '+7' . $phoneDigits,
        'comment' => $comment,
        'source' => $source,
        'page' => $page,
        'extra' => $extraLines,
    ], JSON_UNESCAPED_UNICODE);
    if (@file_put_contents($fallbackLog, $line . "\n", FILE_APPEND | LOCK_EX) !== false) {
        @chmod($fallbackLog, 0600); // персональные данные: читать может только владелец
    }
}

lead_log('lead not delivered: all channels failed' . ($fallbackLog !== '' ? ', saved to fallback_log' : ''));
respond(502, ['ok' => false, 'error' => 'Не удалось отправить заявку. Позвоните нам, пожалуйста'] + $channels);
