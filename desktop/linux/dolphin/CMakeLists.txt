# Cloudy's sync badges in Dolphin (KDE): a KIO overlay icon plugin (Qt plugin in <Qt plugins>/kf6/overlayicon).
# Built by build.sh in a Debian 13 container → build/cloudyoverlay.so
cmake_minimum_required(VERSION 3.16)
project(cloudyoverlay LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 REQUIRED COMPONENTS Core Network)
find_package(KF6KIO REQUIRED)
add_library(cloudyoverlay MODULE cloudyoverlay.cpp)
set_target_properties(cloudyoverlay PROPERTIES PREFIX "" LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/out)
target_compile_options(cloudyoverlay PRIVATE -Wall -Wextra -Werror)
target_link_libraries(cloudyoverlay KF6::KIOCore KF6::KIOWidgets Qt6::Network)
