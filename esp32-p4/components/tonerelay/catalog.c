#include "tonerelay.h"

#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "esp_littlefs.h"
#include "esp_log.h"

#define TAG "tr_cat"
#define CAT_BASE "/catalog"
#define CAT_MAX_FILE (6 * 1024 * 1024)

static const char *REQUIRED[] = {
    "HX_ModelCatalog.json",
    "Helix.sym",
};

static const char *ALLOWED[] = {
    "HX_ModelCatalog.json",
    "HelixControls.json",
    "Helix.sym",
    "amp.models",
    "cab.models",
    "cabmicirs.models",
    "cabmicirswithpan.models",
    "compressor.models",
    "delay.models",
    "distortion.models",
    "eq.models",
    "filter.models",
    "fixed.models",
    "gate.models",
    "io.models",
    "modulation.models",
    "pitch-synth.models",
    "preamp.models",
    "reverb.models",
    "sendreturn.models",
    "volumepan.models",
    "wah.models",
};

static bool s_mounted;

static bool name_ok(const char *name)
{
    if (!name || !name[0] || strchr(name, '/') || strchr(name, '\\')) {
        return false;
    }
    for (size_t i = 0; i < sizeof(ALLOWED) / sizeof(ALLOWED[0]); i++) {
        if (strcmp(name, ALLOWED[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool file_exists(const char *name)
{
    char path[96];
    snprintf(path, sizeof(path), CAT_BASE "/%s", name);
    struct stat st;
    return stat(path, &st) == 0 && st.st_size > 0;
}

static bool has_models(void)
{
    for (size_t i = 0; i < sizeof(ALLOWED) / sizeof(ALLOWED[0]); i++) {
        const char *n = ALLOWED[i];
        size_t len = strlen(n);
        if (len > 7 && strcmp(n + len - 7, ".models") == 0 && file_exists(n)) {
            return true;
        }
    }
    return false;
}

void tonerelay_catalog_start(void)
{
    esp_vfs_littlefs_conf_t conf = {
        .base_path = CAT_BASE,
        .partition_label = "catalog",
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "littlefs mount failed: %s", esp_err_to_name(err));
        s_mounted = false;
        return;
    }
    s_mounted = true;
    ESP_LOGI(TAG, "catalog fs at " CAT_BASE);
}

bool tonerelay_catalog_ready(void)
{
    if (!s_mounted) {
        return false;
    }
    for (size_t i = 0; i < sizeof(REQUIRED) / sizeof(REQUIRED[0]); i++) {
        if (!file_exists(REQUIRED[i])) {
            return false;
        }
    }
    return has_models();
}

const char *tonerelay_catalog_name_ok(const char *name)
{
    return name_ok(name) ? name : NULL;
}

int tonerelay_catalog_put(const char *name, const uint8_t *data, size_t len)
{
    if (!s_mounted || !name_ok(name) || !data) {
        return -1;
    }
    if (len == 0 || len > CAT_MAX_FILE) {
        return -2;
    }
    char path[96];
    snprintf(path, sizeof(path), CAT_BASE "/%s", name);
    FILE *f = fopen(path, "wb");
    if (!f) {
        return -3;
    }
    size_t w = fwrite(data, 1, len, f);
    fclose(f);
    return w == len ? 0 : -4;
}

FILE *tonerelay_catalog_open_put(const char *name)
{
    if (!s_mounted || !name_ok(name)) {
        return NULL;
    }
    char path[96];
    snprintf(path, sizeof(path), CAT_BASE "/%s", name);
    return fopen(path, "wb");
}

int tonerelay_catalog_status_json(char *buf, size_t len)
{
    if (!buf || len < 32) {
        return -1;
    }
    size_t o = 0;
    o += (size_t)snprintf(
        buf + o,
        len - o,
        "{\"ok\":true,\"op\":\"catalog_status\",\"mounted\":%s,\"ready\":%s,\"files\":[",
        s_mounted ? "true" : "false",
        tonerelay_catalog_ready() ? "true" : "false"
    );
    bool first = true;
    if (s_mounted) {
        DIR *d = opendir(CAT_BASE);
        if (d) {
            struct dirent *ent;
            while ((ent = readdir(d)) != NULL && o + 80 < len) {
                if (ent->d_name[0] == '.' || !name_ok(ent->d_name)) {
                    continue;
                }
                char path[96];
                snprintf(path, sizeof(path), CAT_BASE "/%s", ent->d_name);
                struct stat st;
                long sz = 0;
                if (stat(path, &st) == 0) {
                    sz = (long)st.st_size;
                }
                o += (size_t)snprintf(
                    buf + o,
                    len - o,
                    "%s{\"name\":\"%s\",\"bytes\":%ld}",
                    first ? "" : ",",
                    ent->d_name,
                    sz
                );
                first = false;
            }
            closedir(d);
        }
    }
    o += (size_t)snprintf(buf + o, len - o, "]}");
    return (int)o;
}
