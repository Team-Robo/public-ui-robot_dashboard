import os
from glob import glob

from setuptools import setup, find_packages

package_name = 'robot_dashboard'

# Frontend static build output, if it's been built yet (frontend/dist/**).
# Globs to an empty list before the frontend is built, so this stays safe
# to run at any point in the package's lifecycle.
frontend_dist = 'frontend/dist'
static_data_files = []
if os.path.isdir(frontend_dist):
    for f in glob(os.path.join(frontend_dist, '**', '*'), recursive=True):
        if os.path.isfile(f):
            rel_dir = os.path.dirname(os.path.relpath(f, frontend_dist))
            install_dir = os.path.join('share', package_name, 'static', rel_dir)
            static_data_files.append((install_dir, [f]))

setup(
    name=package_name,
    version='0.0.1',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'), glob('launch/*.launch.py')),
        (os.path.join('share', package_name, 'config'), glob('config/*.yaml')),
        (os.path.join('share', package_name, 'windows_companion'), glob('windows_companion/*.py')),
    ] + static_data_files,
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='Nanyang Technological University Team Robo',
    maintainer_email='teamrobontu@gmail.com',
    description='Web dashboard: process control, param hotloading, BT visualization, embedded Lichtblick viz',
    license='Apache-2.0',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'dashboard_server = robot_dashboard.main:main',
            'dashboard_debug_harness = robot_dashboard.debug.harness:main',
        ],
    },
)
