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

idf_component_register(
    SRCS
        "usb.c"
        "wifi.c"
        "http.c"
        "ble.c"
        "tonerelay.c"
        "c6_ota.c"
        "catalog.c"
        "www_embed.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        usb
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_http_server
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
