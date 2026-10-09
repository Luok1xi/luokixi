from django.urls import path
from . import api
from . import companion_bridge
from .admin import site, manage_assets

urlpatterns = [path('manage/', site.urls), path('manage-assets/<path:path>', manage_assets),
               path('api/hub/companion-bridge',companion_bridge.endpoint), path('api/hub/<path:route>',api.endpoint), path('hub/',api.workbench),
               path('hub/assets/<str:name>',api.client_file)]
