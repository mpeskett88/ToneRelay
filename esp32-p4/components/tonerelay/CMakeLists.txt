if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/www_embed.c")
    file(WRITE "${CMAKE_CURRENT_LIST_DIR}/www_embed.c"
         "#include <stddef.h>\n#include <stdint.h>\n"
         "typedef struct { const char *path; const uint8_t *data; size_t len; } www_file_t;\n"
         "const www_file_t www_files[] = {{0}};\n"
         "const size_t www_files_count = 0;\n")
endif()

set(_tonerelay_partitions "${CMAKE_CURRENT_LIST_DIR}/../../partitions.csv")
if(EXISTS "${_tonerelay_partitions}")
    foreach(_dest IN ITEMS "${CMAKE_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/..")
        if(IS_DIRECTORY "${_dest}")
            file(COPY "${_tonerelay_partitions}" DESTINATION "${_dest}")
        endif()
    endforeach()
endif()

if(NOT CMAKE_BUILD_EARLY_EXPANSION)
    execute_process(
        COMMAND python3 "${CMAKE_CURRENT_LIST_DIR}/gen_www.py"
                "${CMAKE_CURRENT_LIST_DIR}/../../../hxbridge/static"
                "${CMAKE_CURRENT_LIST_DIR}/www_embed.c"
    )
endif()

# The build's profile (profiles/README.md): the default one in this folder, or the one TONERELAY_PROFILE_DIR points at.
set(_profile_dir "${CMAKE_CURRENT_LIST_DIR}/profiles/tonerelay")
if(DEFINED ENV{TONERELAY_PROFILE_DIR} AND NOT "$ENV{TONERELAY_PROFILE_DIR}" STREQUAL "")
    set(_profile_dir "$ENV{TONERELAY_PROFILE_DIR}")
endif()
get_filename_component(_profile_dir "${_profile_dir}" ABSOLUTE)
if(NOT EXISTS "${_profile_dir}/profile.c")
    message(FATAL_ERROR "tonerelay: no profile.c in ${_profile_dir} (set TONERELAY_PROFILE_DIR to a profile folder)")
endif()
message(STATUS "tonerelay: profile ${_profile_dir}")
set(_profile_embed "")
if(EXISTS "${_profile_dir}/setup.html")
    set(_profile_embed "${_profile_dir}/setup.html")
endif()

idf_component_register(
    SRCS
        "${_profile_dir}/profile.c"
        "usb.c"
        "wifi.c"
        "reset_button.c"
        "http.c"
        "relay.c"
        "profile.c"
        "ble.c"
        "blemidi.c"
        "midi_ble.c"
        "usb_midi.c"
        "tonerelay.c"
        "c6_ota.c"
        "catalog.c"
        "www_embed.c"
    INCLUDE_DIRS "include"
    EMBED_TXTFILES ${_profile_embed}
    PRIV_REQUIRES
        usb
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_http_server
        lwip
        esp_timer
        mdns
        bt
        vfs
        driver
        esp_hosted
        joltwallet__littlefs
)

set(_slave_fw "${CMAKE_CURRENT_LIST_DIR}/slave_fw/network_adapter.bin")
if(EXISTS "${_slave_fw}")
    target_add_binary_data(${COMPONENT_LIB} "${_slave_fw}" BINARY)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE TONERELAY_HAS_SLAVE_FW=1)
endif()
