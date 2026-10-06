include_guard(GLOBAL)

if(BUILD_TESTING AND NOT MODULE_MOD-MAP-WIDGET STREQUAL "disabled")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
    "${CMAKE_CURRENT_LIST_DIR}/tests/MapWidgetStateTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/MapWidgetMetadataTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/MapWidgetObservationTest.cpp"
    "${CMAKE_CURRENT_LIST_DIR}/tests/MapWidgetHttpTest.cpp")
  set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_INCLUDES
    "${CMAKE_CURRENT_LIST_DIR}/src")
  if(MODULE_MOD-MAP-WIDGET STREQUAL "dynamic")
    set_property(GLOBAL APPEND PROPERTY ACORE_MODULE_TEST_SOURCES
      "${CMAKE_CURRENT_LIST_DIR}/src/MapWidgetState.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/MapWidgetMetadata.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/MapWidgetObservation.cpp"
      "${CMAKE_CURRENT_LIST_DIR}/src/MapWidgetHttp.cpp")
  endif()
endif()
